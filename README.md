# MDE.tv for Grayjay (unofficial)

Brings MDE.tv into Grayjay: every MDE.tv series appears as a creator, episodes play in Grayjay, and logging in unlocks members-only videos.

## Install

Grayjay installs plugins from a URL, so the two files need to be hosted somewhere public:

1. Create a public GitHub repo (or GitLab / any static host) and upload `MDETVConfig.json` and `MDETVScript.js` side by side.
2. In `MDETVConfig.json`, set `sourceUrl` to the raw URL of the config file itself, e.g.
   `https://raw.githubusercontent.com/<you>/mdetv-grayjay/main/MDETVConfig.json`
3. In Grayjay: **Sources → + (Add source) → Install by URL**, paste that same raw URL. (Or turn the URL into a QR code and scan it.)

## Log in (for paid content)

Sources → MDE.tv → **Login**. Sign in on the MDE.tv page that opens. When the site sends you back to the MDE.tv home page, Grayjay saves your session and closes the window. Paid episodes then play normally.

## Put all shows in the Creators tab

After logging in: Sources → MDE.tv → **Import subscriptions**. The plugin subscribes you to every series listed on mde.tv/series, so each show shows up under Creators. Run it again later to pick up new shows.

You can also find individual shows by searching with the **Channels** filter.

## How it works

MDE.tv is a Next.js site with no public API. The plugin loads the same pages your browser does (with your login cookies when you're signed in) and reads the series list, episode list and stream URLs from the data embedded in each page. It recognises HLS (`.m3u8`), MP4 and Mux playback IDs.

## If something doesn't work

Turn on **Debug logging** in the plugin's settings, reproduce the problem, then check Grayjay's log (Settings → Developer, or Grayjay Desktop's dev portal). Lines start with `[MDE.tv]` and show what was found on each page.

- **Login window never closes:** the site may not redirect to the exact home URL after sign-in. Tap the MDE.tv logo to go home; if it still stays open, the `completionUrl` in the config needs changing, or switch to `cookiesToFind` with the session cookie's name.
- **"Couldn't find a playable stream":** the site isn't embedding the stream URL in the page HTML (it's fetched separately by the player). The fix is to add that request to `getContentDetails` once its URL is known.
