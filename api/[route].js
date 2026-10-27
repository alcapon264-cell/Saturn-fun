// Single serverless function for every thin route (see lib/routes.js). api/owner.js and api/irys-upload.js remain separate.
import { getApp } from '../lib/deps.js';
import { dispatch } from '../lib/routes.js';

export default function handler(req, res) {
  return dispatch(getApp, req, res);
}
