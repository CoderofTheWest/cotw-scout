// electron-builder afterSign hook — submits the signed .app to Apple's
// notary service, waits for approval, and staples the ticket.
//
// Credentials:
//   - App-specific password: read from macOS Keychain
//     (service: "cotw-notarization", account: "notarization")
//   - Apple ID: env APPLE_ID
//   - Team ID: env APPLE_TEAM_ID
//   - Signing identity: env CSC_NAME
//
// To store the password in Keychain once:
//   security add-generic-password -s "cotw-notarization" \
//     -a "notarization" -w "xxxx-xxxx-xxxx-xxxx"

const { notarize } = require('@electron/notarize');
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  // Bypass: when network conditions can't sustain a 370MB upload to Apple's
  // notary service, set SKIP_NOTARIZE=1 to produce an unnotarized .app/DMG.
  // The DMG can then be submitted manually via `xcrun notarytool submit`,
  // which has more robust retry behavior than @electron/notarize and is
  // easier to retry independently if the upload drops mid-stream.
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  // macOS automatically writes com.apple.provenance xattrs onto native
  // binaries (.node, .dylib, spawn-helper) AFTER codesign has sealed the
  // bundle. Those xattr writes invalidate the seal, so @electron/notarize's
  // checkSignatures step then refuses to submit AND Apple's notary service
  // itself rejects on seal validation. Strip all xattrs and re-sign before
  // either path (in-build notarization or SKIP_NOTARIZE manual submit). The
  // identity comes from electron-builder.yml mac.identity.
  const signingIdentity = process.env.CSC_NAME;
  if (!signingIdentity) {
    throw new Error('[notarize] CSC_NAME is required for macOS signing');
  }
  const entitlementsPath = path.join(
    context.packager.projectDir,
    'assets',
    'entitlements.mac.plist'
  );

  console.log('[notarize] stripping xattrs and re-sealing app before submit');
  try {
    execSync(`xattr -cr "${appPath}"`, { stdio: 'inherit' });
    execSync(
      `codesign --force --deep --options runtime --timestamp ` +
        `--entitlements "${entitlementsPath}" ` +
        `--sign "${signingIdentity}" "${appPath}"`,
      { stdio: 'inherit' }
    );
  } catch (err) {
    console.error('[notarize] re-seal step failed');
    throw err;
  }

  if (process.env.SKIP_NOTARIZE === '1') {
    console.log('[notarize] SKIP_NOTARIZE=1 — skipping in-build notarization.');
    console.log('[notarize] App has been re-sealed; resulting DMG is ready for manual submit.');
    console.log('[notarize] Recommended manual path (decoupled submit/poll, no --wait):');
    console.log('[notarize]   xcrun notarytool submit dist/<dmg> \\');
    console.log('[notarize]     --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \\');
    console.log('[notarize]     --password "$(security find-generic-password -s cotw-notarization -a notarization -w)"');
    console.log('[notarize]   xcrun notarytool info <id> --apple-id ... --team-id ... --password ...');
    console.log('[notarize]   xcrun stapler staple dist/<dmg>');
    return;
  }

  let appleIdPassword;
  try {
    appleIdPassword = execSync(
      'security find-generic-password -s "cotw-notarization" -a "notarization" -w',
      { encoding: 'utf8' }
    ).trim();
  } catch (err) {
    console.error('\n[notarize] FAILED: app-specific password not found in Keychain.');
    console.error('[notarize] Store it with:');
    console.error('  security add-generic-password -s "cotw-notarization" -a "notarization" -w "xxxx-xxxx-xxxx-xxxx"\n');
    throw err;
  }

  const appleId = process.env.APPLE_ID;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !teamId) {
    throw new Error('[notarize] APPLE_ID and APPLE_TEAM_ID are required for notarization');
  }

  console.log(`[notarize] Submitting ${appName}.app to Apple notary service`);
  console.log(`[notarize] Team: ${teamId} | Apple ID: ${appleId}`);
  console.log('[notarize] (this typically takes 5-15 minutes)');

  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log(`[notarize] ✓ notarization complete; ticket stapled to ${appName}.app`);
};
