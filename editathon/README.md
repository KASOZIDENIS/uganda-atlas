# Uganda Mega Editathon: how this part of the site works

Page: `editathon.html` (linked from the site's top bar and a banner on every page).

## Before Saturday

1. **Add the participants.** Edit `editathon/participants.json` on GitHub. One line per person:
   `{"user": "Wikimedia username", "team": "optional"}`. Only listed people appear on the leaderboard.
2. **Check the dates** in `editathon/config.json` (`start`, `end`, in UTC). They are set to start Saturday 21 November 2026 00:00 East Africa Time and end Saturday 12 December 2026 23:59 East Africa Time. Points are also in that file.
3. **Allow the scheduled job to publish.** In the repository: Settings > Actions > General > Workflow permissions > "Read and write permissions". Then Actions > "Editathon leaderboard" > Run workflow once, so the first data file exists.

## How it stays live

- The page reads each participant's edits straight from the Wikimedia APIs every minute (English Wikipedia, Luganda Wikipedia, the Runyankore test on the Incubator, Wikidata, Commons). One request covers up to 50 people per project.
- A GitHub job (`.github/workflows/leaderboard.yml`) repeats this every ~10 minutes and saves `leaderboard.json` and `metrics.json` on the `editathon-data` branch. The page uses that as a quick first view and for the banner; the hourly `metrics.json` checks which task-list items now have their image, and feeds the "Live check" strip on the English, Luganda, Runyankore and Wikidata dashboards.
- The scoring is in `editathon/board.js` (one file used by both the page and the job).

## Task lists

`MEGA EDITATHON/*.xlsx` are the source. After changing them, run `python scripts/build_tasks.py` to rebuild `editathon/tasks/`.

## Notes

- Everything else on the site (the dashboards) is still the September 2026 snapshot. Only the editathon pages and the "Live check" strip are live.
- Prizes: one winner per project (English, Commons, Wikidata, Luganda, Runyankore), ranked by points earned on that project alone. One person may win several. Reviewers run `node scripts/winners.mjs` (private, prints only). It re-checks every counted edit and drops any that were deleted, undone or reverted (`findDead` in `board.js`).
- Wikidata: the Luganda description earns 2 points per item per person, whether done in one edit or several. Labels earn nothing (they are nearly the same in every language).
- Reverted edits earn nothing; only the listed contribution types earn points (see `points` in config.json); only article/item/file/category edits count (not talk pages).
- To test the leaderboard before Saturday, temporarily set `start` to an earlier date in `config.json` and add yourself to `participants.json`.
