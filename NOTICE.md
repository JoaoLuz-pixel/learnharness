# Notice

## This is a modified version of LearnHarness

This repository is an **unofficial fork** of **[LearnHarness](https://github.com/amosblomqvist/learnharness)** ([learnharness.ai](https://learnharness.ai)), created by **Amos Blomqvist** and developed with its contributors. The fork is maintained by [JoaoLuz-pixel](https://github.com/JoaoLuz-pixel). It is not affiliated with or endorsed by the original project, and all credit for LearnHarness itself belongs to its author and contributors.

LearnHarness is free software, licensed under the **GNU Affero General Public License, version 3 only** (AGPL-3.0-only). This fork keeps that license unchanged; see [`LICENSE`](LICENSE). Copyright in the original work remains with its author and contributors; the fork's own changes are released under the same license.

## Original author and contributors

- **Author:** Amos Blomqvist ([@amosblomqvist](https://github.com/amosblomqvist))
- **Contributors to the original project** (from its GitHub contributor list, 39 accounts, in order of contributions): [@amosblomqvist](https://github.com/amosblomqvist), [@franco-g-s](https://github.com/franco-g-s), [@amenders](https://github.com/amenders), [@SmitMachhi](https://github.com/SmitMachhi), [@IsaacZhangg](https://github.com/IsaacZhangg), [@Ivanko1608](https://github.com/Ivanko1608), [@d-buckner](https://github.com/d-buckner), [@MarcusXavierr](https://github.com/MarcusXavierr), [@xolah88457](https://github.com/xolah88457), [@qrilka](https://github.com/qrilka), [@t1mdurden](https://github.com/t1mdurden), [@mwbini](https://github.com/mwbini), [@ruspg](https://github.com/ruspg), [@Bean0-0](https://github.com/Bean0-0), [@Elyan023](https://github.com/Elyan023), [@Tang3n](https://github.com/Tang3n), [@wvlvrd](https://github.com/wvlvrd), [@victorbelmontee](https://github.com/victorbelmontee), [@sa1ntsinner](https://github.com/sa1ntsinner), [@lickbot](https://github.com/lickbot), [@iamabhishekt](https://github.com/iamabhishekt), [@himanishpuri](https://github.com/himanishpuri), [@ferponse](https://github.com/ferponse), [@chryzsh](https://github.com/chryzsh), [@cacti9](https://github.com/cacti9), [@anikam13](https://github.com/anikam13), [@ccjeff](https://github.com/ccjeff), [@skh-07](https://github.com/skh-07), [@Owen000](https://github.com/Owen000), [@MaxWang007](https://github.com/MaxWang007), [@Martin-Tazon](https://github.com/Martin-Tazon), [@KeyGP](https://github.com/KeyGP), [@bbMisk](https://github.com/bbMisk), [@Hadrien-Cornier](https://github.com/Hadrien-Cornier), [@Ethan-Prunty](https://github.com/Ethan-Prunty), [@chirag-panjabi](https://github.com/chirag-panjabi), [@casiar](https://github.com/casiar), [@leoank](https://github.com/leoank), [@Nazarami](https://github.com/Nazarami)
- Plus 3 further contributors whose commits are not linked to a GitHub account.

The live list is at <https://github.com/amosblomqvist/learnharness/graphs/contributors>.

## Modifications in this fork

As required by section 5(a) of the AGPL-3.0, this fork states that it modifies the original work. The fork is based on the original's commit [`cb25c8e`](https://github.com/amosblomqvist/learnharness/commit/cb25c8e) (version 0.6.1). Every change since then, by date (each commit link lists the files it changes):

| Date | Commit | Change |
|---|---|---|
| 2026-11-15 | [`937a73f`](https://github.com/JoaoLuz-pixel/learnharness/commit/937a73f) | Paste or drop images into the chat composer, the home screen and the new-session screen; thumbnails with remove; unsent drafts kept locally. |
| 2026-11-15 | [`5ee1b00`](https://github.com/JoaoLuz-pixel/learnharness/commit/5ee1b00) | Send from the "Thinking while reading" box at any time: pauses the open question, posts the note (with images) to the teacher; new "Paused questions" teacher-prompt section. |
| 2026-11-15 | [`57ce355`](https://github.com/JoaoLuz-pixel/learnharness/commit/57ce355) | Device Sync: shared sessions, knowledge graph and jobs across devices through an SSH/SFTP endpoint you control; clearer provider error diagnostics. |
| 2026-11-16 | [`8a25e5b`](https://github.com/JoaoLuz-pixel/learnharness/commit/8a25e5b) | Paste or drop documents as path chips in both text boxes (paperclip added to the thinking box); the read tool reads Word, PowerPoint, Excel, OpenDocument and .zip files. |
| 2026-11-16 | [`c8caabc`](https://github.com/JoaoLuz-pixel/learnharness/commit/c8caabc) | "Don't ask again" for pausing a question is permanent; drafts and keyboard shortcuts survive restarts. |
| 2026-11-17 | [`03c49a7`](https://github.com/JoaoLuz-pixel/learnharness/commit/03c49a7) | Long sessions open recent-first and fill in the older history in the background; launch warm-up request. |
| 2026-11-17 | [`cd9a957`](https://github.com/JoaoLuz-pixel/learnharness/commit/cd9a957) | Native Windows ARM64 installer in builds and releases, with one merged Windows update feed. |
| 2026-11-17 | (release setup) | Fork release setup: the fork's builds update from the fork's releases; unsigned macOS packaging for forks; release notes with this notice; the fork's download page (`site/`); this `NOTICE.md`; README fork notice. Version 0.6.4. |
| 2026-11-18 | (release fixes) | The app's "Release notes" link (Settings → Version) opens this fork's releases, the repo the build updates from; README bug-report links point to this fork's Issues, with the original project's Issues kept for the official app. |
| 2026-11-20 | [`4df9218`](https://github.com/JoaoLuz-pixel/learnharness/commit/4df9218) | Several syncs on one Device Sync endpoint: a connecting device sees every sync and its devices, joins one or creates its own, and can change sync later; the original sync stays in place; a removed sync stops syncing instead of deleting local data. Slightly wider Settings window. |
| 2026-11-21 | [`bc2582c`](https://github.com/JoaoLuz-pixel/learnharness/commit/bc2582c) | Install community plugins from a ready-built .zip (button or drop) with a confirmation and optional enable; duplicates refused; version shown per plugin; updates from a plugin's GitHub releases via an optional manifest `repository` field; manual details under "Advanced". |
| 2026-11-21 | (release) | Version 0.6.5. |
| 2026-11-21 | [`7c45672`](https://github.com/JoaoLuz-pixel/learnharness/commit/7c45672) | Uninstall community plugins (code and data; development folders explained, online repository untouched); new optional plugin hook `ctx.onUninstall` that runs before deletion and may stop the uninstall with a reason. |
| 2026-11-21 | (release) | Version 0.6.6. |

The complete history, with every file changed, is in this repository's commit log: <https://github.com/JoaoLuz-pixel/learnharness/commits/main>.

## Source code

Every release of this fork links to the exact source code it was built from (its git tag), and GitHub attaches source archives to each release. The current source is always available at <https://github.com/JoaoLuz-pixel/learnharness>.

## No warranty

This program is distributed in the hope that it will be useful, but **WITHOUT ANY WARRANTY**; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
