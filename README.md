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

After logging in: Sources → MDE.tv → **Import subscriptions**. The plugin subscribes you to every series on mde.tv/series and every screed writer, so each one shows up under Creators. Run it again later to pick up new shows and writers.

You can also find individual shows or writers by searching with the **Channels** filter.

## How it works

The plugin uses MDE.tv's own API (api.mde.tv), the same one the website uses, with your login cookies when you're signed in. Episodes play from the signed HLS stream the site's player uses. Screeds appear as posts; writers' screeds are listed on their creator page.

## If something doesn't work

Turn on **Debug logging** in the plugin's settings, reproduce the problem, then check Grayjay's log (Settings → Developer, or Grayjay Desktop's dev portal). Lines start with `[MDE.tv]` and show what was found on each page.

- **"Your MDE.tv account doesn't have access" on videos you can watch on the site:** your saved login has expired. Log out and back in under Sources → MDE.tv.
