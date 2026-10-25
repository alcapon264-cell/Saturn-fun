// GET /api/treasury-status   (admin only: Authorization: Bearer <SATURN_ADMIN_SECRET>)
module.exports = require('../lib/treasury').handler('status');
