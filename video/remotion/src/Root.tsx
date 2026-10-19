import { Composition } from "remotion";
import { ExampleVideo } from "./ExampleVideo";
import { Clip, type ClipProps } from "./Clip";

const FPS = 30;

// Sum of all sequence durations minus the overlap eaten by each of the
// 4 swipe transitions (0.35s each) between the 5 scenes. A generated video's
// durations come from the actual ElevenLabs narration timestamps, so the video
// is timed to the voice, not guessed.
const EXAMPLE_TOTAL_S = 4 + 4 + 4.5 + 4.5 + 4 - 4 * 0.35;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* A short cut out of a long take. Unlike the others its length is not
          known until the clip exists, so it comes off the props the cutting
          workflow passes in. */}
      <Composition
        id="Clip"
        component={Clip}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={Math.round(30 * FPS)}
        defaultProps={{ slug: "clip", hook: "", seconds: 30, emphasis: [] } as ClipProps}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(1, Math.round((props.seconds || 30) * FPS)),
        })}
      />
      <Composition
        id="Example"
        component={ExampleVideo}
        durationInFrames={Math.round(EXAMPLE_TOTAL_S * FPS)}
        fps={FPS}
        width={1080}
        height={1920}
      />
    </>
  );
};
