
## The holdout rig itself — verified, not assumed

`metrics.mjs` implements the stratified holdout the design relies on to prove the
graph pays for itself. Before trusting any number it produces, the rig was checked
directly at a configured fraction of 0.2:

| property | result |
| --- | --- |
| deterministic within an epoch | true — same (anchor, epoch) always same arm |
| observed rate over 4,000 anchors | 0.216 |
| arm flips for one file across 200 epochs | 72 |

The last row is the one that matters and the easiest to get wrong. If a file were
hashed into one arm permanently, the comparison would be between *files* rather
than within them, and the whole reason for stratifying would be lost. It flips,
so the within-file comparison the design describes is real.

The rig is sound. What it lacks is data: injections had fired once in the
project's history before this work, because there were no findings to serve.
