# Setting up Card & Cash Ledger: step by step

This guide takes you from the folder on your Mac to the app installed on your phone and laptop, with optional sync through your own Google Drive. You don't need to write any code. Allow about 45 minutes the first time.

There are five parts:

1. Save your current data (5 minutes)
2. Publish the app on GitHub Pages (15 minutes)
3. Install it on your laptop and phone (5 minutes)
4. Optional: create your Google "client ID" for Drive sync (15 minutes)
5. Optional: turn on sync (5 minutes)

The app works fully after part 3. Parts 4 and 5 are only needed if you want your phone and laptop to share the same data.

---

## Part 1: Save your current data first

The new app lives at a new web address, so it **can't see** what the old `card-cash-ledger.html` file saved in Chrome. Move your data across with a backup:

1. Open the old `card-cash-ledger.html` in Chrome, the same way you normally do.
2. Scroll down and open **Settings · cards, budgets, rates, backup**.
3. Click **Download backup**. A file called something like `ledger-backup-2026-11-05.json` goes to your Downloads folder.
4. Keep that file. You'll restore it in part 3.

If you used the old file on more than one computer, do this on each one and restore the one with the most complete data. (After sync is set up, you won't need to juggle backups like this.)

---

## Part 2: Publish the app on GitHub Pages (free)

GitHub Pages hosts the app's files for free at an address like `https://yourname.github.io/ledger/`.

**Your expenses are never uploaded to GitHub.** Only the app's program files go there. Your data stays on your devices (and, if you choose, in your own Google Drive). The program files will be public, which is normal and safe: they contain no personal information.

### 2a. Create a GitHub account

1. Go to <https://github.com/signup> and create a free account.
2. Pick your username carefully: it becomes part of the app's address. For example, the username `gshort` gives you `https://gshort.github.io/ledger/`.

### 2b. Create a repository (a project folder on GitHub)

1. Once you're signed in, go to <https://github.com/new>.
2. **Repository name:** `ledger` (or any short name with no spaces).
3. Choose **Public**. Free GitHub Pages needs a public repository.
4. Leave every other option as it is (don't add a README).
5. Click **Create repository**.

### 2c. Upload the app's files

1. On the new, empty repository page, click the link **uploading an existing file** (in the line "Get started by creating a new file or uploading an existing file").
2. On your Mac, open the **card-cash-ledger-pwa** folder in Finder.
3. Press **Cmd + Shift + .** (full stop) to show hidden files. A file called `.nojekyll` appears. Include it.
4. Press **Cmd + A** to select everything *inside* the folder (the files and the folders `fonts`, `icons`, `js`, `tests`, `tools`, `vendor`), and drag it all onto the GitHub page.
   - Drag the *contents*, not the `card-cash-ledger-pwa` folder itself. When you're done, `index.html` should sit at the top level of the repository, not inside another folder.
5. Wait until every file has finished uploading (about 70 files).
6. Scroll down and click **Commit changes**.

### 2d. Switch on GitHub Pages

1. In your repository, click **Settings** (the tab at the top).
2. In the left menu, click **Pages**.
3. Under **Build and deployment** → **Source**, choose **Deploy from a branch**.
4. Under **Branch**, choose **main** and **/ (root)**, then click **Save**.
5. Wait one or two minutes, then refresh the page. A box appears saying **Your site is live at** `https://yourname.github.io/ledger/`.
6. Open that address in Chrome. You should see the ledger with its example rows. Bookmark the address and write it down: you'll need it again in part 4.

---

## Part 3: Install the app

### On your laptop (Chrome on Mac or Windows)

1. Open your app's address (`https://yourname.github.io/ledger/`) in Chrome.
2. Install it using any of these:
   - Click **Install app** in the small grey status line under the title, or
   - Click the install icon at the right end of the address bar (a small screen with a downward arrow), or
   - Open Chrome's **⋮** menu → **Cast, save, and share** → **Install page as app…**
3. Click **Install**. The ledger opens in its own window and appears in your Applications folder or Start menu, and in the Dock or taskbar if you pin it.

### On your Android phone (Chrome)

1. Open your app's address in Chrome on the phone.
2. Tap **⋮** (top right) → **Add to home screen** → **Install**. (On some phones the menu item is called **Install app**.)
3. The Ledger icon appears on your home screen and in your app drawer. It opens full-screen like any other app.

### Bring your data in (on one device only)

1. Open the installed app on the device you use most.
2. Open **Settings · cards, budgets, rates, backup, sync** at the bottom.
3. Under **Backup & restore**, click **Restore backup or import ledger CSV** and choose the `.json` file from part 1.
4. Check the message and click **Replace**.
5. If you'll use sync, **don't** restore the backup on your other devices as well. Sync copies the data across in part 5.

**Offline:** once installed, the app works with no internet connection, including reading PDF statements.

---

## Part 4 (optional): Create your Google client ID for Drive sync

Sync goes through **your own** Google Drive. There's no server in between and no other company involved. To allow that, Google needs to know about your copy of the app, which takes a free "Google Cloud project". You won't be charged: the app uses no paid services, and Google won't ask for a card for this.

Use the Google account whose Drive should hold the sync file. Have your app address from part 2 to hand.

### 4a. Create the project

1. Go to <https://console.cloud.google.com/> and sign in.
2. If asked, accept the terms of service.
3. At the top, click the project picker (it may say **Select a project**) → **New project**.
4. **Project name:** `Ledger sync`. Click **Create**, wait a few seconds, and make sure the new project is selected in the picker at the top.

### 4b. Switch on the Google Drive API

1. Go to <https://console.cloud.google.com/apis/library/drive.googleapis.com> (check the project picker still shows **Ledger sync**).
2. Click **Enable**.

### 4c. Set up the sign-in screen

Google's menus get renamed from time to time. If something is called slightly differently, look for the closest match.

1. Go to <https://console.cloud.google.com/auth/overview> (also reachable as **APIs & Services → OAuth consent screen**, or **Google Auth Platform**).
2. Click **Get started**.
3. **App name:** `Card & Cash Ledger`. **User support email:** your email. Click **Next**.
4. **Audience:** choose **External**. Click **Next**.
5. **Contact information:** your email. Click **Next**.
6. Tick the box to agree to the policy, then click **Continue** → **Create**.
7. In the left menu, click **Audience**. Under **Test users**, click **Add users**, enter the Gmail address(es) you'll sign in with on your phone and laptop, and click **Save**.
   - Leave the **Publishing status** as **Testing**. That's fine for personal use: only the test users you list can sign in.
8. In the left menu, click **Data Access** → **Add or remove scopes**. In the filter box type `drive.file`, tick the row that ends in `/auth/drive.file` ("See, edit, create and delete only the specific Google Drive files you use with this app"), click **Update**, then **Save**.
   - This is the narrowest Drive permission: the app can see **only the file it creates itself**, nothing else in your Drive.

### 4d. Create the client ID

1. In the left menu, click **Clients** → **Create client** (or **Create credentials → OAuth client ID**).
2. **Application type:** **Web application**.
3. **Name:** `Ledger web app`.
4. Under **Authorised JavaScript origins**, click **Add URI** and enter your GitHub Pages address **without** the `/ledger/` part and with no slash at the end. For example:
   `https://yourname.github.io`
5. Leave **Authorised redirect URIs** empty.
6. Click **Create**.
7. A box shows your **Client ID**, a long value ending in `.apps.googleusercontent.com`. Copy it.
   - Google may also show a **client secret**. **Ignore it.** Don't copy it anywhere. The app is built so that it never needs one.

### 4e. Put the client ID into the app

1. On GitHub, open your `ledger` repository and click the file **config.js**.
2. Click the pencil icon (**Edit this file**) at the top right of the file.
3. Find this line:
   ```
   export const GOOGLE_CLIENT_ID = "";
   ```
   and paste your client ID between the two quote marks, so it looks like this (yours will be different):
   ```
   export const GOOGLE_CLIENT_ID = "123456789012-abcdefg123.apps.googleusercontent.com";
   ```
   Keep the quote marks and the semicolon. Change nothing else.
4. Click **Commit changes…** → **Commit changes**.
5. Wait two minutes for GitHub Pages to update, then close and reopen the app on each device (do it twice if the sync section still says "Sync is off").

---

## Part 5 (optional): Turn on sync

### On your first device (the one with your data)

1. Open the app → **Settings** → **Sync with Google Drive** → **Connect Google Drive**.
2. A Google window opens. Choose your account.
3. You'll probably see **"Google hasn't verified this app"**. That's expected: it's your own private app in testing mode. Click **Continue**.
4. On the permissions screen, make sure the box for Drive access is **ticked**, then click **Continue**.
5. The sync section shows **Up to date** and **Last synced: just now**. In your Google Drive you'll find a file named **Card & Cash Ledger - sync data.json**. Leave it alone: don't edit, move or share it.

If nothing happens when you click Connect, Chrome may have blocked the pop-up. Click the blocked pop-up icon in the address bar, allow pop-ups for the site, and try again.

### On your other devices

1. Install the app (part 3), but **don't restore a backup**.
2. **Settings → Sync with Google Drive → Connect Google Drive**, the same Google account, same steps.
3. Your data appears within a few seconds. The example rows disappear too if you cleared them on the first device.

### How sync behaves

- **When it syncs:** when you open the app, a couple of seconds after each change, when the connection comes back, and every few minutes while the app is open.
- **Offline:** changes are saved on the device straight away and wait in a queue. The status line under the title says how many are waiting ("Offline · 2 changes waiting"); they upload when you're back online.
- **Edits on two devices:** sync works one transaction at a time. Change different transactions on your phone and laptop, even while both are offline, and both changes are kept. If you edit *the same* transaction on both, the edit made later wins for that transaction. A deletion made after an edit removes the transaction everywhere; an edit made after a deletion brings it back.
- **Settings** (card days, budgets, rates, "paid" marks) merge item by item in the same way.
- **The Google sign-in lasts about an hour.** That's how Google handles apps with no server of their own. After that, the status line says **Sign in to sync**. Tap it, then **Sync now**, and choose your account. Nothing is lost while it's paused: changes wait on the device.
- **Last sync time and errors** are shown in the status line under the title and in full under Settings → Sync with Google Drive.
- **Restoring a backup while sync is on** replaces the data on *all* your synced devices (the app warns you before it does this).
- **To stop syncing** on a device, click **Disconnect**. The data on that device stays.
- **To start sync afresh,** delete the Drive file and empty Drive's bin; the next device that syncs uploads its own data again.

### Optional: encrypt the Drive file with a passphrase

Without this, the Drive file is protected by your Google account like any other file in your Drive. With it, the file is scrambled with a passphrase that only you know, so even someone who got into your Drive couldn't read it.

1. **Settings → Sync with Google Drive → Encrypt the Drive file with a passphrase…**
2. Choose a passphrase of at least 10 characters. Several unrelated words work well, for example `velvet tractor monsoon 47`.
3. Type it twice, tick **I understand a lost passphrase can't be recovered**, and click **Encrypt Drive file**.
4. Each other device then shows **Waiting for the sync passphrase**. Enter it there once and click **Unlock**.

> ⚠️ **If you forget the passphrase, the Drive copy can't be opened by you, by Google or by anyone else.** There is no reset. The data on each device stays readable, and you can still download ordinary (unencrypted) backups, but you would have to turn encryption off or reset sync to use Drive again. Write the passphrase down somewhere safe, for example in a password manager.

The passphrase itself is never stored. Each device keeps only a locked key made from it, which can't be copied out of the app.

---

## Keeping your data safe

- Your data lives in the installed app on each device. **Uninstalling the app, or clearing the site's data in Chrome, deletes that device's copy.** With sync on, the other devices and Drive still have it.
- The app asks Chrome to keep its storage permanently. Installing the app makes Chrome much more likely to agree. Settings → Backup & restore tells you which.
- **Download a backup now and then** anyway (Settings → Download backup). The status line reminds you after two weeks. The backup file is the same format as before, so old backups restore fine.

## Updates

When a new version of the app is uploaded to GitHub, each device downloads it in the background and shows **"A new version of the app is ready" → Reload**.

If you ever replace the app's files on GitHub, upload them the same way as in part 2c. Your `config.js` must keep your client ID, so if you upload a fresh `config.js`, paste the client ID into it again.

## Troubleshooting

| What you see | What to do |
|---|---|
| Google says **Error 400: origin_mismatch** or **redirect_uri_mismatch** | The "Authorised JavaScript origin" in part 4d doesn't match. It must be exactly `https://yourname.github.io` (no `/ledger`, no slash at the end). After changing it, wait 5 minutes. |
| Google says **Access blocked … has not completed the Google verification process** or **access_denied** | The Google account you chose isn't on the **Test users** list (part 4c step 7). Add it. |
| **Drive access wasn't granted** | On Google's permissions screen, the Drive box was unticked. Click Connect again and tick it. |
| Sync section still says **Sync is off** after adding the client ID | Wait two minutes, then close and reopen the app twice. Check config.js on GitHub: the ID must be inside the quote marks and end with `.apps.googleusercontent.com`. |
| **Sign in to sync** keeps coming back | Normal: Google's sign-in lasts about an hour. Tap it and then **Sync now**. |
| **Waiting for the sync passphrase** | Encryption is on (or the passphrase was changed) on another device. Enter the current passphrase. |
| **The sync file in Drive couldn't be read** | Someone edited the Drive file. Nothing was overwritten. Delete the Drive file (and empty the bin) to start sync afresh from this device. |
| The app page shows **404** | GitHub Pages isn't on yet, or `index.html` ended up inside a sub-folder. Check part 2c step 4 and part 2d. |
