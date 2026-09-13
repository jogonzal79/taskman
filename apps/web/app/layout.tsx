import type { Metadata, Viewport } from "next";

import "./globals.css";

/**
 * El layout raiz del App Router. Hasta este paso `apps/web` no tenia ninguno: solo
 * servia Route Handlers, que no lo necesitan.
 *
 * El AVISO DE PANTALLA ANGOSTA vive aca y no en la pagina porque vale para toda la
 * UI, no para una ruta: la decision de producto de F3 es que la UI es SOLO
 * ESCRITORIO y que por debajo de 1024px va un mensaje, no una version degradada
 * (el responsive de columnas con pestanas de la 9.3 queda descartado). Se resuelve
 * con una media query en `globals.css`, sin medir nada en el cliente: leer el
 * ancho en JavaScript obligaria a un "use client" y a renderizar primero lo que no
 * corresponde.
 */

export const metadata: Metadata = {
  title: "TaskMan",
  description: "Tablero Kanban personal.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <div className="solo-escritorio">{children}</div>
        <p className="aviso-angosto">
          TaskMan es una aplicacion de escritorio: el tablero necesita al menos 1024 px
          de ancho para mostrar sus columnas.
        </p>
      </body>
    </html>
  );
}
