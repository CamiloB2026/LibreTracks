import { create } from "zustand";

/**
 * Which song the "Analizar canción" modal is open for. A store, like the
 * render modal's, so every song menu opens it with one call and nothing is
 * threaded through TransportPanelContent.
 */
type SongAnalysisTarget = { regionId: string; regionName: string };

type SongAnalysisStore = {
  target: SongAnalysisTarget | null;
  show: (target: SongAnalysisTarget) => void;
  close: () => void;
};

export const useSongAnalysisStore = create<SongAnalysisStore>()((set) => ({
  target: null,
  show: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export const openSongAnalysis = (target: SongAnalysisTarget) =>
  useSongAnalysisStore.getState().show(target);
