# Bitunix Strategy Data

Daily research data for BTCUSDT and ETHUSDT from the Bitunix public futures market API.

## Schedule

GitHub Actions runs daily at 05:50 Asia/Taipei and writes:

- `latest.json` — newest completed daily result
- `archive/YYYY-MM-DD.json` — historical daily results

## Current baseline

`N_Structure_v0_14_2_FIX1`

Confirmed logic included:

- Effective N requires at least 3 raw candles.
- BOS requires: existing N → internal N break → neutral → same-direction rebuild → break original extension/weak end → BOS → larger same-direction N.
- FVG: bullish `low > high[2]`; bearish `high < low[2]`.
- Fully filled FVG/zone can remain structural background but is not a fresh trading candidate.

Not automated yet:

- left-side liquidity algorithm
- secondary-to-major promotion rule
- any still-unconfirmed teacher-specific zone boundary rule

No account credentials or Bitunix API keys are used.
