# TOJ for iPhone

The TOJ app (tojcampaign.com/app) as a real iPhone app, with three things a web page can't do:

- **Share to TOJ.** In Photos, Safari, Files or any app with a Share button, tap Share → TOJ, add a note, and tap Post. The next time you open TOJ, it's waiting in **New idea**. Photos, links, videos (3 or 6 stills each), PDFs (their words) and text all work.
- **The camera.** New idea → Camera opens the iPhone camera directly.
- **Notifications from Apple.** You get the same alerts as the web app (draft ready, brief ready, kit approved), delivered the way native iPhone apps get them.

Everything else is the web app itself, so changes to `public/app/` reach the iPhone app with no new build. Only changes inside `mobile/` need a new build.

**You don't need a Mac.** Apple only builds iPhone apps on a Mac, so the build runs on GitHub's Macs (`.github/workflows/ios.yml`), which are free for this public repo. Everything below happens in a web browser on Windows.

---

## Two ways to get it onto phones

| | TestFlight (start here) | App Store, unlisted |
|---|---|---|
| Who | Up to 100 people on your App Store Connect team | Anyone with the link (not searchable) |
| Apple review | None for your own team | Once, plus each update |
| Lasts | Each build works for 90 days; run the build again to refresh | Until you remove it |
| Good for | You and the 4–5 person team, now | Later, if you want a normal App Store install link |

Apple names employee tools as a fit for [unlisted distribution](https://developer.apple.com/support/unlisted-app-distribution). It still goes through App Review, and anyone with the link can install it. That's fine here, because TOJ only opens for people you've invited.

---

## Set it up (one time, about an hour of clicking)

### 1. Join the Apple Developer Program

Enroll at [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll). It costs $99 a year.
- **As the LLC (better):** the store shows the company as the seller. You'll need a free D-U-N-S number, which can take a few days.
- **As yourself:** faster, but your own name shows as the seller.

When you're in, open **Membership details** and copy your **Team ID** (10 characters).

### 2. Register the app's IDs

In [Certificates, Identifiers & Profiles → Identifiers](https://developer.apple.com/account/resources/identifiers/list), click **+** three times:

1. **App Groups** → Description `TOJ` → Identifier `group.com.tojcampaign.app`
2. **App IDs → App** → Description `TOJ` → Bundle ID (Explicit) `com.tojcampaign.app`.
   - Tick **App Groups**, click Configure, and choose `group.com.tojcampaign.app`.
   - Tick **Push Notifications**.
3. **App IDs → App** → Description `TOJ Share` → Bundle ID `com.tojcampaign.app.share`. Tick **App Groups** and choose the same group.

Bundle IDs are permanent once registered. If you'd rather use a different one, tell Claude first, because it's set in a few places (see "Changing the bundle ID" below).

### 3. Make the notifications key, and give it to the server

1. In [Keys](https://developer.apple.com/account/resources/authkeys/list), click **+**, name it `TOJ notifications`, and tick **Apple Push Notifications service (APNs)**.
2. If it asks which environment, choose **Sandbox & Production**.
3. Download the `.p8` file. **Apple lets you download it only once.** Note the **Key ID**.
4. In Render, open **toj-csv-app → Environment** and add:

| Key | Value |
|---|---|
| `APNS_KEY_ID` | the Key ID |
| `APNS_TEAM_ID` | your Team ID |
| `APNS_KEY_P8` | open the .p8 in Notepad and paste everything, including the BEGIN and END lines |
| `APNS_BUNDLE_ID` | `com.tojcampaign.app` |

Until these are set, phones that turn notifications on are remembered, and they start getting notifications once the key is in.

### 4. Create the app in App Store Connect

In [App Store Connect](https://appstoreconnect.apple.com), go to **Apps → + → New App**:
- **Platform:** iOS.
- **Name:** whatever is free. "TOJ" alone may be taken; something like `TOJ Team` works, and the Home Screen still shows **TOJ**.
- **Language:** English (U.S.).
- **Bundle ID:** `com.tojcampaign.app`.
- **SKU:** `toj-ios-1`.
- **User access:** Full Access.

### 5. Make the key GitHub builds with

1. In App Store Connect, go to **Users and Access → Integrations → App Store Connect API → Team Keys → +**.
2. Name it `GitHub builds` and give it **Admin** access, which it needs to make the signing certificate.
3. Download the `.p8` (once only) and note the **Key ID** and the **Issuer ID** shown above the list.

### 6. A private place for the signing certificate, and the GitHub secrets

The first build makes the app's signing certificate. It keeps the certificate, encrypted, in a private repo so later builds reuse it.

1. On GitHub, create a **private**, empty repo named `toj-ios-certificates`.
2. Create a **fine-grained personal access token** in GitHub → Settings → Developer settings:
   - **Repository access:** only `toj-ios-certificates`.
   - **Permissions:** Contents set to **Read and write**.
3. In Windows PowerShell, turn the token into the value GitHub's build needs. Paste your token in place of `PASTE_TOKEN`:
   ```powershell
   [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("kcumby2-wq:PASTE_TOKEN"))
   ```
4. Make up a long passphrase for the certificate and save it in your password manager.
5. In **TojCampaign → Settings → Secrets and variables → Actions → New repository secret**, add these seven secrets. Nobody can read them back, not even on a public repo, and pull requests from forks never see them.

| Secret | Value |
|---|---|
| `APPLE_TEAM_ID` | your Team ID |
| `ASC_KEY_ID` | the Key ID from step 5 |
| `ASC_ISSUER_ID` | the Issuer ID from step 5 |
| `ASC_KEY_P8` | the whole text of the step 5 `.p8` |
| `MATCH_PASSWORD` | the passphrase you made up |
| `MATCH_GIT_URL` | `https://github.com/kcumby2-wq/toj-ios-certificates.git` |
| `MATCH_GIT_BASIC_AUTHORIZATION` | the PowerShell output |

### 7. Build and upload

1. Go to **GitHub → TojCampaign → Actions → iOS app → Run workflow**.
2. Tick **Upload to TestFlight**, then click **Run workflow**.
3. It takes about 15 to 25 minutes. If a secret is missing, the run stops and names it.

### 8. Put it on your phone, and the team's

1. In App Store Connect, open your app → **TestFlight → Internal Testing → +**, make a group called `Team`, and add yourself.
2. On your iPhone, install **TestFlight** from the App Store. Open the invite email, then install TOJ.
3. **Teammates:**
   - In **Users and Access**, add each one as a user. The **Developer** or **Marketing** role is enough; they don't need Admin.
   - Add them to the `Team` group.
   - Separately, invite them in the TOJ app (**Team → Invite**). Apple's invite lets them install the app; your TOJ invite lets them sign in.

### 9. Try it

- Sign in. Turn notifications on in **Team → Notifications**, then tap **Send a test**.
- In Photos, pick two photos → **Share** → **TOJ** → type a note → **Post**. Open TOJ: they're in New idea with your note.
- In Safari, share a page to TOJ the same way. It shows up as a link.

---

## Going on the App Store (unlisted), later

Apple checks these before approving:

- **A privacy policy that covers the app.** A draft section is in `mobile/APP-PRIVACY-DRAFT.md`, for counsel. Once approved, add it to tojcampaign.com/privacy.
- **Screenshots** for a 6.9-inch iPhone. Claude can make these from the app.
- **The age rating questionnaire and the App Privacy answers.** Draft answers are below.
- **A sign-in for the reviewer.**
  - Invite an address you control (for example `appreview@tojcampaign.com`) as a **Member**, so the reviewer can reach New idea, the camera and Share.
  - Put the email and password in the App Review notes.
  - Remove them after approval.
- **Account deletion.** It's in the app at **Team → Delete my account**.

Review notes you can paste in, then edit:

> TOJ is an internal tool for the Trail of Joy production team (4–5 people). Accounts are invite-only. We're requesting unlisted distribution. Demo account (Member role): [email] / [password].
> To try the Share extension: in Photos, select a photo → Share → TOJ → Post, then open TOJ. The photo appears in New idea. Tap "Write the brief" to send it to the Brief Writer.
> Camera: New idea → Camera. Notifications: Team → Notifications → on → Send a test. Account deletion: Team → Delete my account.

Then [request unlisted distribution](https://developer.apple.com/contact/request/unlisted-app/).

### App Privacy answers (draft; confirm with counsel)

| Data | Used for | Linked to the person |
|---|---|---|
| Name, email address | App functionality (sign-in, team list) | Yes |
| Other user content: ideas, briefs, notes, links, text from PDFs | App functionality | Yes |
| Photos or videos: sent to the Brief Writer (Anthropic) when you tap Write the brief; TOJ doesn't store them | App functionality | Yes, while the brief runs |
| Device token for notifications | App functionality | Yes |

- **Tracking:** none.
- **Advertising:** none.
- **Sale of data:** none.

---

## How the phone handles data

- **Shared items stay on the phone.**
  - The Share extension prepares everything on the iPhone: photos are shrunk to 1280 px, videos become stills with no sound, and PDFs become their words.
  - The result waits in TOJ's private storage on the phone.
  - It's deleted when you open it in TOJ, or after 7 days if you don't.
  - File names are never kept, and nothing uploads from the Share sheet.
- **Same rules as New idea.**
  - Photos go to the Brief Writer only when you tap **Write the brief**, for that brief only.
  - The rules about minors don't change: no identifiable minors without consent on file.
- **Notification text** carries a kit name and a link into the app only, never an athlete's name, contact or film.

---

## For whoever maintains this

| Path | What it is |
|---|---|
| `capacitor.config.json` | The app ID, the address it opens (`https://tojcampaign.com/app/`), the user agent tag `TOJApp/1`, and the offline page |
| `src/native.js` | The camera, notifications and Share inbox code for the web app. Run `npm run bundle` after changing it, and commit `public/app/native.js` |
| `www/offline.html` | Shown when the phone is offline |
| `ios/App/App/` | The app: `MainViewController.swift` registers `SharedInboxPlugin.swift`; `AppDelegate.swift` hands notification tokens to Capacitor; `App.entitlements` |
| `ios/App/ShareExtension/` | The Share extension (`ShareViewController.swift`, `Info.plist`, entitlements) |
| `ios/App/Shared/` | `TOJInbox.swift` (the on-phone inbox both targets use) and the privacy manifest |
| `ios/App/fastlane/` | The TestFlight lane |
| `scripts/make-icons.py` | Draws the app icon and launch image |

- **Every change to `mobile/`** gets compiled for the simulator on GitHub's Macs, on the pull request.
- **Locally**, on any OS: `npm ci && npx cap sync ios`. Building needs a Mac or the workflow.
- **The web app loads `native.js`** only when the user agent has `TOJApp/1`. In a browser, nothing changes.
- **Server side:**
  - `utils/apns.js` sends to Apple. It tries production, then sandbox, and remembers which worked.
  - `routes/push.js` takes `{ apns: { token } }`.
  - `DELETE /api/team/me` deletes an account.
  - Migration 020 adds `kind` and `apns_env` to `push_subscriptions`.

### Changing the bundle ID

Before registering anything with Apple, change it in all of these:
- `TOJ_BUNDLE_ID` in `ios/App/App.xcodeproj/project.pbxproj`, at the project level, both Debug and Release.
- `appId` in `capacitor.config.json`.
- `TOJ_BUNDLE_ID` for the Fastfile, if you add it as an environment variable in the workflow.
- The App Group check in `.github/workflows/ios.yml`.
- `APNS_BUNDLE_ID` on Render.
