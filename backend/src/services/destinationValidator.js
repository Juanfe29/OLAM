// Validador de extensiones destino para SIPp tests.
//
// Approach: lista estática vía `VALID_EXTENSIONS` en .env (BLOCK-01 / Phase 1).
// La razón de no consultar la 3CX Call Control API en runtime es triple:
//   1. La API no está documentada como expone la lista de extensiones,
//      requeriría research adicional fuera del scope de Phase 1.
//   2. Latencia: POST /api/tests/run debe responder <500ms; un roundtrip
//      a la API más SSH overhead puede romper esa ventana.
//   3. Failure mode: si la API cae, hay que decidir fail-open (inseguro)
//      o fail-closed (rompe los tests). Lista estática evita esa decisión.
//
// La lista es operada por el equipo (config en .env) y se actualiza on-demand
// cuando OLAM confirma extensiones nuevas. Tradeoff aceptado: pequeño costo
// operativo a cambio de zero latencia + zero failure mode.

const RAW = process.env.VALID_EXTENSIONS || '';
const ALLOWLIST = RAW
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Patrón seguro para extensiones: solo dígitos, 2–8 caracteres.
// Evita inyección si la lista llega corrupta del .env.
const SAFE_EXTENSION_RE = /^\d{2,8}$/;

export function getValidExtensions() {
  return ALLOWLIST.filter(ext => SAFE_EXTENSION_RE.test(ext));
}

export function isValidExtension(destination) {
  if (!destination || typeof destination !== 'string') return false;
  if (!SAFE_EXTENSION_RE.test(destination)) return false;
  // Si la allowlist está vacía (ej. dev local sin .env configurado),
  // permitir cualquier extensión que pase el regex de seguridad.
  // En producción .35 hay que setear VALID_EXTENSIONS o el operador
  // se queda sin red de seguridad — el runbook (Phase 6) lo documenta.
  if (ALLOWLIST.length === 0) return true;
  return ALLOWLIST.includes(destination);
}

export function validateDestinationOrThrow(destination) {
  if (!destination || typeof destination !== 'string') {
    throw new Error('Falta el destino (extensión) para el test SIPp.');
  }
  if (!SAFE_EXTENSION_RE.test(destination)) {
    throw new Error(
      `Destino inválido: "${destination}". Debe ser una extensión numérica de 2 a 8 dígitos.`,
    );
  }
  if (ALLOWLIST.length > 0 && !ALLOWLIST.includes(destination)) {
    const valid = ALLOWLIST.join(', ');
    throw new Error(
      `Extensión "${destination}" no está en la lista de destinos válidos del 3CX. ` +
      `Configurar VALID_EXTENSIONS en .env. Extensiones permitidas: ${valid}.`,
    );
  }
}
