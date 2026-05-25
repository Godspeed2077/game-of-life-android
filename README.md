# Game of Life — Android (Capacitor)

Real native Android APK that wraps the Game of Life PWA in a Capacitor shell.
Every push to `main` triggers GitHub Actions to build, sign, and publish a new APK release.

## One-time setup

1. **Create a new GitHub repo** at https://github.com/new
   - Name: `game-of-life-android`
   - Visibility: doesn't matter
   - Don't add a README, .gitignore, or license — we have ours

2. **Push the contents of this folder** to that repo:
   ```bash
   cd capacitor-build
   git init
   git add .
   git commit -m "initial"
   git branch -M main
   git remote add origin https://github.com/godspeed2077/game-of-life-android.git
   git push -u origin main
   ```

3. **Add two GitHub Secrets** at `Settings → Secrets and variables → Actions → New repository secret`:

   | Name | Value |
   |---|---|
   | `KEYSTORE_BASE64` | Base64 of `android.keystore` (run: `base64 -w 0 android.keystore`) |
   | `KEYSTORE_PASSWORD` | The password from `keystore-password.txt` |

   Both files live in `~/gol-build/` from when we generated them earlier. They're at the bottom of this README too for convenience.

4. **First build runs automatically** when you push. Watch it at `https://github.com/godspeed2077/game-of-life-android/actions`. Takes 5-7 minutes.

5. **APK appears** at `https://github.com/godspeed2077/game-of-life-android/releases/latest`

## Every subsequent build

Just push to `main`. The workflow:
- Sets up JDK 17 + Android SDK
- Adds the Android platform via Capacitor
- Bundles `www/` into the APK
- Signs with your keystore
- Publishes to a fresh GitHub release

## Updating the web content

The `www/` folder is the bundled content. To update what the APK shows:
1. Copy new files into `www/`
2. Commit and push
3. New APK builds automatically
