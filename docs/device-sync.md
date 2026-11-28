# Device Sync

Device Sync keeps your sessions, knowledge graph and jobs the same on all your devices. Each device always works on its own files. Changes are sent within about a second, and other devices' changes arrive on the interval you choose in **Settings → Device Sync**. Losing the connection never interrupts learning: the device works locally and catches up later.

API keys and provider logins never sync. Each device keeps its own.

## Choose where to sync

Open **Settings → Device Sync → Set up Device Sync**. Under **Connect**, there are three choices.

### Cloud folder (OneDrive, iCloud Drive, Dropbox, Google Drive)

The simplest choice when your devices already use one of these services.

1. Install the provider's app on every device and sign in with the same account. LearnHarness does not sign in to the provider itself; the provider's app copies the files.
2. Choose **Cloud folder**. Pick the provider's folder from the suggestions, type its path, or use **Browse…**.
3. Choose **Check folder**, then create a sync or join one.

LearnHarness creates a `LearnHarness Sync` folder inside the folder you pick. Changes take as long to arrive as your provider takes to copy them. Nothing is lost meanwhile: a device waits for files that have not arrived yet.

iCloud Drive works on Windows (the iCloud for Windows app) and macOS. Apple offers no iCloud Drive app for Linux.

### One of your computers ("Host sync on this device")

One of your computers can serve as the endpoint for the others, with no admin commands.

On that computer:

1. Under **Host sync on this device**, turn it on.
2. Choose **Create a sync**. Give it a name and a password. Every sync on a host has a password.
3. To sync this computer too, choose **Connect → This device's host** and join the sync.

On each other device:

1. Choose **Connect → Another device or SSH endpoint**.
2. Type one of the host's addresses, shown under **Host sync on this device** on the host, and its port (7419 by default).
3. Check that the identity shown matches the one on the host, then join the sync with its password.

The host must be on and LearnHarness open for the others to sync. While hosting, closing the window keeps LearnHarness running in the system tray (on macOS, in the Dock). Quit it from the tray icon.

#### Devices on other networks: Tailscale

The host accepts connections only from the local network and from [Tailscale](https://tailscale.com), never from public internet addresses. To sync devices that are not on the same network:

1. Install Tailscale on the host and on each other device. It is free for personal use.
2. Sign in with the same Tailscale account everywhere.
3. A Tailscale address (100.x.y.z) appears under **Host sync on this device**. Type it on the other devices.

Tailscale reaches the host from any network without opening your router, and exposes nothing to the internet.

On Windows, the first time the host runs, Windows may ask whether LearnHarness may accept connections. Allow it for private networks.

### An SSH endpoint you control

The original kind of endpoint: a computer or server with an SSH server and a dedicated, locked-down sync user. Choose **Connect → Another device or SSH endpoint → Set up an SSH endpoint** for this device's key and the commands for Linux, macOS or Windows. Each device's key must be allowed on the endpoint before it can connect.

## Several syncs per endpoint

Every kind of endpoint can hold several syncs, for example one per person or per subject. A connecting device sees them all, joins one or creates its own, and can move to another later with **Change sync**. When joining, a device either merges its own progress into the sync or sets it aside, to restore later.

## Sync passwords

A sync can have a password, chosen when the sync is created. It cannot be added, changed or removed later.

- **Required** on the built-in host. **Optional** on cloud folders and SSH endpoints.
- **Everything the sync stores is encrypted** with it: sessions, graph, device names and the creator. Without the password, nobody can read the sync, including the endpoint's owner and the cloud provider.
- **Devices without the password see only the sync's name and a lock.**
- **Each device types the password once.** It then keeps the sync's key in the system's secure storage: Windows protected storage, the macOS Keychain, or the Linux keyring.
- **If every device forgets the password,** the sync's copy on the endpoint cannot be recovered. Each device keeps its own progress, which a new sync can start from.

On the built-in host, the host itself checks the password: a device without it can't read, change or delete anything. On a cloud folder or an SSH endpoint, the files are only encrypted. Someone with access to that folder or endpoint can't read a protected sync, but could still delete its files there.

Wrong passwords on a host are limited to five tries per ten minutes from one address.

## Conflicts

When the same session was changed on two devices before they synced, Device Sync asks which version to keep, or keeps both as separate sessions. Until you decide, only that item waits; everything else keeps syncing. Graph knowledge added on two devices merges without asking.

## Disconnect and Forget

- **Disconnect** pauses sync and keeps this device's key and remembered passwords.
- **Forget** removes the endpoint and deletes this device's key and remembered passwords. Progress on this device stays.

Before the first sync with any endpoint, a full backup of this device's data is taken.
