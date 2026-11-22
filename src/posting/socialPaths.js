'use strict';
// Shared filesystem locations for the Instagram club features.
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CLUBS_FILE = path.join(ROOT, 'data', 'instagram', 'clubs.json');
const SEED_FILE = path.join(ROOT, 'src', 'config', 'insta-clubs.json');
const DP_DIR = path.join(ROOT, 'data', 'instagram', 'dp');
const COOKIE_FILE = path.join(ROOT, 'data', 'instagram', 'cookies.json');
const POSTS_FILE = path.join(ROOT, 'data', 'instagram', 'posts.json');

module.exports = { ROOT, CLUBS_FILE, SEED_FILE, DP_DIR, COOKIE_FILE, POSTS_FILE };
