# CubeJS Service

## Recent Changes

### CubeJS Version Upgrade (v1.3.23 → v1.3.85)

**Upgrade Method:** `npm update`

**What we did:**
1. Ran `npm install` to install current dependencies
2. Ran `npm update` to upgrade CubeJS packages to latest versions
3. Verified the upgrade worked with `npm list`
4. Tested basic package loading

**Result:**
- All `@cubejs-backend/*` packages upgraded from 1.3.23 to 1.3.85
- Package-lock.json updated with new versions
- Basic functionality verified

**Note:** When this branch is pushed to GitHub, the selective build workflow will automatically detect changes in `services/cubejs/` and build the `quicklookup/synmetrix-cube` container image.