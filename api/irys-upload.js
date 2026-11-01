const ALLOWED_ORIGINS = (process.env.SATURN_ALLOWED_ORIGINS || "")
  .split(",")
  .map((x) => x.trim().replace(/\/+$/, ""))
  .filter(Boolean);

function cors(req, res) {
  const origin = String(req.headers.origin || "").replace(/\/+$/, "");

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({
      error: "CORS origin not allowed",
      origin
    });
  }

  return true;
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || "").match(
    /^data:([^;,]+)?(?:;base64)?,([\s\S]*)$/
  );

  if (!match) return null;

  const mime = match[1] || "application/octet-stream";
  const data = match[2];

  const buffer = dataUrl.includes(";base64,")
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data));

  return { buffer, mime };
}

export default async function handler(req, res) {
  if (cors(req, res) !== true) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};

    const input =
      body.dataUrl ||
      body.data ||
      body.image ||
      body.file;

    if (!input) {
      return res.status(400).json({
        error: "Missing upload data"
      });
    }

    const parsed = dataUrlToBuffer(input);

    if (!parsed) {
      return res.status(400).json({
        error: "Upload must be a data URL"
      });
    }

    if (parsed.buffer.length > 3 * 1024 * 1024) {
      return res.status(413).json({
        error: "Upload exceeds 3 MiB limit"
      });
    }

    const { Uploader } = await import("@irys/upload");
    const { Solana } = await import("@irys/upload-solana");

    const privateKey = process.env.IRYS_SOLANA_PRIVATE_KEY;

    if (!privateKey) {
      return res.status(500).json({
        error: "IRYS_SOLANA_PRIVATE_KEY is not configured"
      });
    }

    const irys = await Uploader(Solana)
  .withWallet(privateKey)
  .withRpc("https://api.mainnet-beta.solana.com");
      
    const receipt = await irys.upload(parsed.buffer, {
      tags: [
        {
          name: "Content-Type",
          value: parsed.mime
        }
      ]
    });

    const id = receipt?.id;

    if (!id) {
      throw new Error("Irys returned no transaction id");
    }

    return res.status(200).json({
      id,
      uri: `https://gateway.irys.xyz/${id}`
    });
  } catch (error) {
    console.error("Irys upload failed:", error);

    return res.status(500).json({
      error: error?.message || "Irys upload failed"
    });
  }
           }
