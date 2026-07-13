import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { displayPackage, upsertPackage } from './packages';
import type { Package } from '../types/models';

/**
 * Property-based test for the Packages page representation (task 20.2).
 *
 * Feature: react-frontend-migration, Property 33: Representación de un grupo de
 * cuentas — For any grupo con cualquier nombre y cualquier lista de ids de
 * cuenta (incluyendo la lista vacía), `displayPackage(pkg)` incluye el nombre
 * del grupo y exactamente el conjunto de ids que contiene, sin añadir ni
 * omitir ninguno.
 *
 * Validates: Requirements 17.1
 */

/** Generates an arbitrary saved group with any name and any account-id list. */
const arbPackage: fc.Arbitrary<Package> = fc.record({
  id: fc.string(),
  name: fc.string(),
  accountIds: fc.array(fc.string()),
});

describe('displayPackage (Property 33: Representación de un grupo de cuentas)', () => {
  it('carries the name unchanged and exactly the account ids, for any length including empty', () => {
    fc.assert(
      fc.property(arbPackage, (pkg) => {
        // Snapshot the source ids to detect any later mutation of the input.
        const sourceIdsBefore = [...pkg.accountIds];

        const result = displayPackage(pkg);

        // Name is carried through unchanged.
        expect(result.name).toBe(pkg.name);

        // The returned ids equal the input ids exactly — same order, same
        // contents; none added, none omitted, regardless of length.
        expect(result.accountIds).toEqual(pkg.accountIds);

        // accountCount is the length of the contained id list.
        expect(result.accountCount).toBe(pkg.accountIds.length);
        expect(result.accountCount).toBe(result.accountIds.length);

        // Mutating the result must not affect the source package.
        result.accountIds.push('__mutated__');
        expect(pkg.accountIds).toEqual(sourceIdsBefore);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Property-based test for the package save merge (task 20.4).
 *
 * Feature: react-frontend-migration, Property 34: Guardado de un grupo preserva
 * el resto de la lista — For any lista de grupos existente y cualquier grupo
 * guardado (creado o editado), `upsertPackage(list, pkg)` devuelve una nueva
 * lista en la que el grupo con `pkg.id` se reemplaza en su sitio (edición) o se
 * añade al final (creación), mientras que todos los demás grupos se conservan
 * intactos y en su posición original; la lista de entrada nunca se muta.
 *
 * Validates: Requirements 17.3
 */

/** Generates a group with the given id and an arbitrary name / account-id list. */
const arbPackageWithId = (id: string): fc.Arbitrary<Package> =>
  fc.record({
    id: fc.constant(id),
    name: fc.string(),
    accountIds: fc.array(fc.string()),
  });

/**
 * Generates an existing list of groups with DISTINCT ids together with a saved
 * package that either reuses one of those ids (edit) or introduces a fresh id
 * (create). Distinct ids are drawn from a unique set of id strings so at most
 * one group ever matches `pkg.id`.
 */
const arbListAndSaved = fc
  .uniqueArray(fc.string({ minLength: 1 }), { minLength: 0, maxLength: 8 })
  .chain((ids) =>
    fc.record({
      list: fc.tuple(...ids.map((id) => arbPackageWithId(id))).map((pkgs) => pkgs as Package[]),
      // Either edit an existing id (when the list is non-empty) or create a new one.
      saved: fc
        .oneof(
          // Fresh id guaranteed not to collide with any existing id.
          fc.string({ minLength: 1 }).filter((id) => !ids.includes(id)),
          // Existing id (only meaningful when there is at least one).
          ids.length > 0 ? fc.constantFrom(...ids) : fc.string({ minLength: 1 }).filter((id) => !ids.includes(id)),
        )
        .chain((id) => arbPackageWithId(id)),
    }),
  );

describe('upsertPackage (Property 34: Guardado de un grupo preserva el resto de la lista)', () => {
  it('replaces the matching group in place or appends, preserving every other group, without mutating input', () => {
    fc.assert(
      fc.property(arbListAndSaved, ({ list, saved }) => {
        // Deep snapshot to detect any mutation of the input list.
        const snapshot = JSON.parse(JSON.stringify(list)) as Package[];

        const result = upsertPackage(list, saved);

        const existingIndex = list.findIndex((p) => p.id === saved.id);

        if (existingIndex === -1) {
          // Creating: length grows by one, saved appended, all originals kept in order.
          expect(result).toHaveLength(list.length + 1);
          expect(result[result.length - 1]).toBe(saved);
          for (let i = 0; i < list.length; i += 1) {
            expect(result[i]).toBe(list[i]);
          }
        } else {
          // Editing: same length, matching entry equals saved, others unchanged in place.
          expect(result).toHaveLength(list.length);
          expect(result[existingIndex]).toBe(saved);
          for (let i = 0; i < list.length; i += 1) {
            if (i !== existingIndex) {
              expect(result[i]).toBe(list[i]);
            }
          }
        }

        // The input list must never be mutated.
        expect(list).toEqual(snapshot);
      }),
      { numRuns: 100 },
    );
  });
});
