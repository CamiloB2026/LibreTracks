// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MissingMediaEntry } from "@libretracks/shared/desktopApi";

/**
 * Paso 08 del plan de feedback de testers: el gestor de ficheros que faltan.
 *
 * Lo que este test fija es la parte que puede hacer daño: **nada se enlaza sin
 * que el usuario lo pida**. La búsqueda automática propone candidatos, y un
 * fichero con el mismo nombre no es necesariamente el mismo fichero — enlazar
 * el equivocado en silencio deja una pista sonando algo que no es, que es peor
 * que dejarla muda y avisada.
 */
const getMissingMedia = vi.fn<() => Promise<MissingMediaEntry[]>>();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === "string"
        ? (options.defaultValue as string).replace(
            /\{\{(\w+)\}\}/g,
            (_match, name: string) => String(options[name] ?? ""),
          )
        : key,
  }),
}));

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  getMissingMedia: () => getMissingMedia(),
}));

const { MissingMediaModal } = await import("./MissingMediaModal");

const ENTRY: MissingMediaEntry = {
  filePath: "audio/bateria.wav",
  expectedPath: "/sesiones/Domingo/audio/bateria.wav",
  fileName: "bateria.wav",
  trackNames: ["Bateria", "Coros"],
  clipCount: 3,
  candidates: ["/Multitracks/Domingo/bateria.wav"],
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function renderModal(overrides: Partial<Parameters<typeof MissingMediaModal>[0]> = {}) {
  const props = {
    onClose: vi.fn(),
    onRelink: vi.fn().mockResolvedValue(undefined),
    onLocate: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  render(<MissingMediaModal {...props} />);
  return props;
}

describe("pantalla de archivos que faltan", () => {
  it("quita de la sesión un archivo que falta, después de preguntar", async () => {
    getMissingMedia.mockResolvedValue([ENTRY]);
    const { onRemove, confirm } = renderModal();
    await screen.findByText("bateria.wav");

    fireEvent.click(screen.getByRole("button", { name: "Quitar de la sesión" }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("audio/bateria.wav"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("bateria.wav"));
  });

  it("no quita nada si el usuario cancela", async () => {
    getMissingMedia.mockResolvedValue([ENTRY]);
    const confirm = vi.fn().mockResolvedValue(false);
    const { onRemove } = renderModal({ confirm });
    await screen.findByText("bateria.wav");

    fireEvent.click(screen.getByRole("button", { name: "Quitar de la sesión" }));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Quitar de la sesión" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("lista lo que falta con su ruta esperada y las pistas que lo usan", async () => {
    getMissingMedia.mockResolvedValue([ENTRY]);

    renderModal();

    expect(await screen.findByText("bateria.wav")).toBeTruthy();
    expect(screen.getByText("Lo usan: Bateria, Coros")).toBeTruthy();
    expect(
      screen.getByText("/sesiones/Domingo/audio/bateria.wav"),
    ).toBeTruthy();
  });

  it("propone el candidato pero NO lo enlaza solo", async () => {
    getMissingMedia.mockResolvedValue([ENTRY]);

    const { onRelink } = renderModal();
    await screen.findByText("bateria.wav");

    // Con la pantalla abierta y el candidato a la vista, todavia no se ha
    // tocado nada: la propuesta es una propuesta.
    expect(onRelink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Usar el de Domingo/ }));
    await waitFor(() =>
      expect(onRelink).toHaveBeenCalledWith(
        "audio/bateria.wav",
        "/Multitracks/Domingo/bateria.wav",
      ),
    );
  });

  it("deja buscar a mano cuando no hay candidato", async () => {
    getMissingMedia.mockResolvedValue([{ ...ENTRY, candidates: [] }]);

    const { onLocate } = renderModal();
    await screen.findByText("bateria.wav");

    expect(screen.queryByRole("button", { name: /Usar el de/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Buscar…" }));
    await waitFor(() =>
      expect(onLocate).toHaveBeenCalledWith("audio/bateria.wav"),
    );
  });

  it("dice que no falta nada en vez de enseñar una lista vacia", async () => {
    getMissingMedia.mockResolvedValue([]);

    renderModal();

    expect(
      await screen.findByText(/No falta ningún archivo/),
    ).toBeTruthy();
  });

  it("no se cae si el backend falla: lo cuenta y sigue en pie", async () => {
    getMissingMedia.mockRejectedValue(new Error("no hay sesion abierta"));

    renderModal();

    // El texto exacto lo decide `formatUserFacingError`, que traduce los
    // errores conocidos; lo que este test fija es que el fallo SALE por
    // pantalla en vez de dejar el modal cargando para siempre.
    const status = await screen.findByText(
      (_content, element) =>
        element?.className.includes("lt-update-check-status--error") ?? false,
    );
    expect(status.textContent).toBeTruthy();
  });
});
