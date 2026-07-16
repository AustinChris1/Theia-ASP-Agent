import { Composition } from 'remotion';
import { Demo } from './Demo';

export const RemotionRoot = () => (
  <Composition
    id="Demo"
    component={Demo}
    durationInFrames={2670}
    fps={30}
    width={1920}
    height={1080}
  />
);
