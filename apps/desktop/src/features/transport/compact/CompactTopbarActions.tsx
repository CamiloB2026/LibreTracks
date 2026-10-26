import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ViewModeSwitcher } from "../timeline/ViewModeSwitcher";
import type { ViewMode } from "../uiStore";

type CompactMenuProps = {
  label: string;
  icon: string;
  active?: boolean;
  children: ReactNode;
};

/**
 * Small, self-closing dropdown used by the compact top bar. It only owns the
 * open/closed UI state; every entry calls an existing handler owned by the
 * transport panel.
 */
function CompactMenu({ label, icon, active = false, children }: CompactMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="lt-compact-topbar-menu" ref={rootRef}>
      <button
        type="button"
        className={`lt-compact-topbar-action${active ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          {icon}
        </span>
        <span className="lt-compact-topbar-action-label">{label}</span>
        <span
          className="material-symbols-outlined lt-compact-topbar-menu-caret"
          aria-hidden="true"
        >
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>
      {open ? (
        <div
          className="lt-top-menu-dropdown lt-compact-topbar-menu-dropdown"
          role="menu"
          aria-label={label}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

type CompactTopbarActionsProps = {
  isProjectEmpty: boolean;
  editorOpen: boolean;
  onToggleEditor: () => void;
  onRestart: () => void;
  onImportAudio: () => void;
  onCreateLibraryFolder: () => void;
  onImportSong: () => void;
  onImportSongPackage: () => void;
  onExportSong: () => void;
  canExportSong: boolean;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  canPersistProject: boolean;
  onOpenSettings: () => void;
  onUndo: () => void;
  onRedo: () => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
};

/**
 * Compact-only action cluster. It is rendered inside the shared TimelineTopbar
 * so the transport controls (play, stop, fade, metronome, guide, pads…) keep
 * their single source of truth. Every entry below delegates to a handler the
 * transport panel already owns.
 */
export function CompactTopbarActions({
  isProjectEmpty,
  editorOpen,
  onToggleEditor,
  onRestart,
  onImportAudio,
  onCreateLibraryFolder,
  onImportSong,
  onImportSongPackage,
  onExportSong,
  canExportSong,
  onNewProject,
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  canPersistProject,
  onOpenSettings,
  onUndo,
  onRedo,
  viewMode,
  onViewModeChange,
}: CompactTopbarActionsProps) {
  const { t } = useTranslation();

  return (
    <div
      className="lt-compact-topbar-actions"
      role="group"
      aria-label={t("compactTopbar.actions", {
        defaultValue: "Acciones de la vista compacta",
      })}
    >
      <button
        type="button"
        className="lt-compact-topbar-action"
        disabled={isProjectEmpty}
        aria-label={t("compactTopbar.restart", { defaultValue: "Inicio" })}
        title={t("compactTopbar.restart", { defaultValue: "Inicio" })}
        onClick={onRestart}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          first_page
        </span>
        <span className="lt-compact-topbar-action-label">
          {t("compactTopbar.restart", { defaultValue: "Inicio" })}
        </span>
      </button>

      <CompactMenu
        label={t("compactTopbar.edit", { defaultValue: "Editar" })}
        icon="edit"
        active={editorOpen}
      >
        <button type="button" role="menuitem" disabled={isProjectEmpty} onClick={onUndo}>
          <span>{t("compactTopbar.undo", { defaultValue: "Deshacer" })}</span>
          <span className="lt-top-menu-shortcut">Ctrl+Z</span>
        </button>
        <button type="button" role="menuitem" disabled={isProjectEmpty} onClick={onRedo}>
          <span>{t("compactTopbar.redo", { defaultValue: "Rehacer" })}</span>
          <span className="lt-top-menu-shortcut">Ctrl+Y</span>
        </button>
        <div className="lt-top-menu-separator" aria-hidden="true" />
        <button type="button" role="menuitem" onClick={onToggleEditor}>
          <span>
            {editorOpen
              ? t("compactTopbar.hideEditor", {
                  defaultValue: "Ocultar herramientas de edición",
                })
              : t("compactTopbar.showEditor", {
                  defaultValue: "Mostrar herramientas de edición",
                })}
          </span>
          <span className="material-symbols-outlined" aria-hidden="true">
            {editorOpen ? "check" : "tune"}
          </span>
        </button>
      </CompactMenu>

      <CompactMenu
        label={t("compactTopbar.add", { defaultValue: "Añadir" })}
        icon="add"
      >
        <button type="button" role="menuitem" onClick={onImportAudio}>
          <span>
            {t("compactTopbar.importAudio", {
              defaultValue: "Importar audio a la biblioteca",
            })}
          </span>
        </button>
        <button type="button" role="menuitem" onClick={onCreateLibraryFolder}>
          <span>
            {t("compactTopbar.createLibraryFolder", {
              defaultValue: "Nueva carpeta de biblioteca",
            })}
          </span>
        </button>
      </CompactMenu>

      {/* The waveform is permanent in the compact view; this shows or puts
          away the utility toolbar (Vamp, marker jump, song transition,
          master, transpose). Same switch as "Editar → herramientas". */}
      <button
        type="button"
        className={`lt-compact-topbar-action${editorOpen ? " is-active" : ""}`}
        aria-pressed={editorOpen}
        aria-label={
          editorOpen
            ? t("compactTopbar.hideEditor", {
                defaultValue: "Ocultar herramientas de edición",
              })
            : t("compactTopbar.showEditor", {
                defaultValue: "Mostrar herramientas de edición",
              })
        }
        title={
          editorOpen
            ? t("compactTopbar.hideEditor", {
                defaultValue: "Ocultar herramientas de edición",
              })
            : t("compactTopbar.showEditor", {
                defaultValue: "Mostrar herramientas de edición",
              })
        }
        onClick={onToggleEditor}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          tune
        </span>
        <span className="lt-compact-topbar-action-label">
          {t("compactTopbar.tools", { defaultValue: "Herramientas" })}
        </span>
      </button>

      <CompactMenu
        label={t("compactTopbar.song", { defaultValue: "Canción" })}
        icon="music_note"
      >
        <button type="button" role="menuitem" onClick={onImportSong}>
          <span>{t("compactTopbar.importSong", { defaultValue: "Importar canción" })}</span>
        </button>
        <button type="button" role="menuitem" onClick={onImportSongPackage}>
          <span>
            {t("compactTopbar.importSongPackage", {
              defaultValue: "Importar paquete .ltpkg",
            })}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!canExportSong}
          onClick={onExportSong}
        >
          <span>
            {t("compactTopbar.exportSong", {
              defaultValue: "Exportar canción seleccionada",
            })}
          </span>
        </button>
      </CompactMenu>

      <CompactMenu
        label={t("compactTopbar.project", { defaultValue: "Proyecto" })}
        icon="folder_open"
      >
        <button type="button" role="menuitem" onClick={onNewProject}>
          <span>{t("compactTopbar.newProject", { defaultValue: "Nuevo proyecto" })}</span>
        </button>
        <button type="button" role="menuitem" onClick={onOpenProject}>
          <span>{t("compactTopbar.openProject", { defaultValue: "Abrir proyecto" })}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!canPersistProject}
          onClick={onSaveProject}
        >
          <span>{t("compactTopbar.saveProject", { defaultValue: "Guardar" })}</span>
          <span className="lt-top-menu-shortcut">Ctrl+S</span>
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!canPersistProject}
          onClick={onSaveProjectAs}
        >
          <span>{t("compactTopbar.saveProjectAs", { defaultValue: "Guardar como" })}</span>
          <span className="lt-top-menu-shortcut">Ctrl+Shift+S</span>
        </button>
      </CompactMenu>

      <button
        type="button"
        className="lt-compact-topbar-action"
        aria-label={t("compactTopbar.settings", { defaultValue: "Ajustes" })}
        title={t("compactTopbar.settings", { defaultValue: "Ajustes" })}
        onClick={onOpenSettings}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          settings
        </span>
        <span className="lt-compact-topbar-action-label">
          {t("compactTopbar.settings", { defaultValue: "Ajustes" })}
        </span>
      </button>

      {/* The editing toolbar already carries its own view switcher. Show the
          compact one only while that toolbar is hidden, so there is exactly
          one DAW/Compacta/Live control on screen. */}
      {!editorOpen && viewMode && onViewModeChange ? (
        <ViewModeSwitcher value={viewMode} onChange={onViewModeChange} />
      ) : null}
    </div>
  );
}
