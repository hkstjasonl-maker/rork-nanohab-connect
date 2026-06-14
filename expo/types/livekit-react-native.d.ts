/**
 * Local typings shim for `@livekit/react-native`.
 *
 * The LiveKit React Native SDK contains native code and cannot be installed in
 * the Rork sandbox (it requires an expo-dev-client build). This declaration lets
 * the app typecheck here. When you create your dev build and install
 * `@livekit/react-native`, you can delete this file — the package ships its own
 * types.
 */
declare module "@livekit/react-native" {
  import type { ReactNode } from "react";
  import type {
    ConnectionState,
    LocalParticipant,
    Participant,
    Room,
  } from "livekit-client";

  export function registerGlobals(): void;

  export const AudioSession: {
    startAudioSession(): Promise<void>;
    stopAudioSession(): Promise<void>;
  };

  export interface LiveKitRoomProps {
    serverUrl: string;
    token: string;
    connect?: boolean;
    audio?: boolean;
    video?: boolean;
    onConnected?: () => void;
    onDisconnected?: () => void;
    onError?: (error: Error) => void;
    children?: ReactNode;
  }

  export function LiveKitRoom(props: LiveKitRoomProps): JSX.Element;

  export function useRoomContext(): Room;
  export function useConnectionState(): ConnectionState;
  export function useParticipants(): Participant[];
  export function useLocalParticipant(): {
    localParticipant: LocalParticipant;
    isMicrophoneEnabled: boolean;
    isCameraEnabled: boolean;
  };
}
