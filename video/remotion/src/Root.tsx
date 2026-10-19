import { Composition } from "remotion";
import { FrameExample } from "./FrameExample";
import { Clip, type ClipProps } from "./Clip";

const FPS = 30;

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
        id="FrameExample"
        component={FrameExample}
        durationInFrames={30}
        fps={FPS}
        width={1080}
        height={1920}
      />
    </>
  );
};
