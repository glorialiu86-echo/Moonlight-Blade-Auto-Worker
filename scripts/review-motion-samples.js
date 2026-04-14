import "../src/config/load-env.js";
import {
  motionReviewPaths,
  readPendingMotionReviewSamples,
  triggerMotionReviewPass
} from "../src/runtime/motion-review.js";

async function main() {
  const pendingBefore = await readPendingMotionReviewSamples();
  const results = await triggerMotionReviewPass();
  const pendingAfter = await readPendingMotionReviewSamples();

  console.log(JSON.stringify({
    pendingBefore: pendingBefore.length,
    reviewedNow: results.length,
    pendingAfter: pendingAfter.length,
    sampleLogPath: motionReviewPaths.sampleLogPath,
    reviewLogPath: motionReviewPaths.reviewLogPath,
    artifactDir: motionReviewPaths.artifactDir,
    latestReviewPath: motionReviewPaths.latestReviewPath
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
