const fs = require('node:fs'), path = require('node:path');
function storagePaths({ root = __dirname, env = process.env } = {}) {
    const dir = path.resolve(env.DATA_DIR || path.join(root, '.local'));
    return {
        statsPath: path.join(dir, 'sponsor-stats.json'),
        campaignsPath: env.DATA_DIR ? path.join(dir, 'sponsor-campaigns.json') : path.join(root, 'sponsorships/campaigns.json'),
        seedPath: path.join(root, 'sponsorships/campaigns.json'),
    };
}
function ensureCampaigns(paths) {
    if (paths.campaignsPath === paths.seedPath) return paths;
    fs.mkdirSync(path.dirname(paths.campaignsPath), { recursive: true });
    try { fs.copyFileSync(paths.seedPath, paths.campaignsPath, fs.constants.COPYFILE_EXCL); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    return paths;
}
module.exports = { storagePaths, ensureCampaigns };
