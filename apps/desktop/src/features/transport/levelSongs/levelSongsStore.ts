import { create } from "zustand";

/**
 * Whether the "Nivelar canciones" modal is open. A store, like the render
 * modal's, so every song menu opens it with one call and nothing is threaded
 * through TransportPanelContent.
 */
type LevelSongsStore = {
  open: boolean;
  show: () => void;
  close: () => void;
};

export const useLevelSongsStore = create<LevelSongsStore>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export const openLevelSongs = () => useLevelSongsStore.getState().show();
