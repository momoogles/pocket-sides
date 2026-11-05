import type { SpeakerTurn } from "./speakerTurn";

export interface PracticeTarget {
  id: string;
  turn: SpeakerTurn;
  nextTurn?: SpeakerTurn;
  sceneNumber: number;
  sceneLabel: string;
  minimumStartIndex: number;
  defaultStartIndex: number;
  defaultEndIndex: number;
}
