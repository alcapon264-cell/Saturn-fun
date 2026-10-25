// POST /api/treasury-sweep   (admin only: Authorization: Bearer <SATURN_ADMIN_SECRET>)  — ignores any request body.
module.exports = require('../lib/treasury').handler('sweep');
