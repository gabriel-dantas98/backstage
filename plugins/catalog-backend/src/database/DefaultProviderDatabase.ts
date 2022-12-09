/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { isDatabaseConflictError } from '@backstage/backend-common';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { DeferredEntity } from '@backstage/plugin-catalog-node';
import { Knex } from 'knex';
import lodash from 'lodash';
import { v4 as uuid } from 'uuid';
import type { Logger } from 'winston';
import { rethrowError } from './conversion';
import { checkLocationKeyConflict } from './operations/refreshState/checkLocationKeyConflict';
import { insertUnprocessedEntity } from './operations/refreshState/insertUnprocessedEntity';
import { updateUnprocessedEntity } from './operations/refreshState/updateUnprocessedEntity';
import { DbRefreshStateReferencesRow, DbRefreshStateRow } from './tables';
import {
  ProviderDatabase,
  RefreshByKeyOptions,
  ReplaceUnprocessedEntitiesOptions,
  Transaction,
} from './types';
import { generateStableHash } from './util';

// The number of items that are sent per batch to the database layer, when
// doing .batchInsert calls to knex. This needs to be low enough to not cause
// errors in the underlying engine due to exceeding query limits, but large
// enough to get the speed benefits.
const BATCH_SIZE = 50;

export class DefaultProviderDatabase implements ProviderDatabase {
  constructor(
    private readonly options: {
      database: Knex;
      logger: Logger;
    },
  ) {}

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      let result: T | undefined = undefined;

      await this.options.database.transaction(
        async tx => {
          // We can't return here, as knex swallows the return type in case the transaction is rolled back:
          // https://github.com/knex/knex/blob/e37aeaa31c8ef9c1b07d2e4d3ec6607e557d800d/lib/transaction.js#L136
          result = await fn(tx);
        },
        {
          // If we explicitly trigger a rollback, don't fail.
          doNotRejectOnRollback: true,
        },
      );

      return result!;
    } catch (e) {
      this.options.logger.debug(`Error during transaction, ${e}`);
      throw rethrowError(e);
    }
  }

  async replaceUnprocessedEntities(
    txOpaque: Transaction,
    options: ReplaceUnprocessedEntitiesOptions,
  ): Promise<void> {
    const tx = txOpaque as Knex.Transaction;

    const { toAdd, toUpsert, toRemove } = await this.createDelta(tx, options);

    if (toRemove.length) {
      let removedCount = 0;
      const rootId = () => {
        if (tx.client.config.client.includes('mysql')) {
          return tx.raw('CAST(NULL as UNSIGNED INT)', []);
        }

        return tx.raw('CAST(NULL as INT)', []);
      };
      for (const refs of lodash.chunk(toRemove, 1000)) {
        /*
        WITH RECURSIVE
          -- All the nodes that can be reached downwards from our root
          descendants(root_id, entity_ref) AS (
            SELECT id, target_entity_ref
            FROM refresh_state_references
            WHERE source_key = "R1" AND target_entity_ref = "A"
            UNION
            SELECT descendants.root_id, target_entity_ref
            FROM descendants
            JOIN refresh_state_references ON source_entity_ref = descendants.entity_ref
          ),
          -- All the nodes that can be reached upwards from the descendants
          ancestors(root_id, via_entity_ref, to_entity_ref) AS (
            SELECT CAST(NULL as INT), entity_ref, entity_ref
            FROM descendants
            UNION
            SELECT
              CASE WHEN source_key IS NOT NULL THEN id ELSE NULL END,
              source_entity_ref,
              ancestors.to_entity_ref
            FROM ancestors
            JOIN refresh_state_references ON target_entity_ref = ancestors.via_entity_ref
          )
        -- Start out with all of the descendants
        SELECT descendants.entity_ref
        FROM descendants
        -- Expand with all ancestors that point to those, but aren't the current root
        LEFT OUTER JOIN ancestors
          ON ancestors.to_entity_ref = descendants.entity_ref
          AND ancestors.root_id IS NOT NULL
          AND ancestors.root_id != descendants.root_id
        -- Exclude all lines that had such a foreign ancestor
        WHERE ancestors.root_id IS NULL;
        */
        removedCount += await tx<DbRefreshStateRow>('refresh_state')
          .whereIn('entity_ref', function orphanedEntityRefs(orphans) {
            return (
              orphans
                // All the nodes that can be reached downwards from our root
                .withRecursive('descendants', function descendants(outer) {
                  return outer
                    .select({ root_id: 'id', entity_ref: 'target_entity_ref' })
                    .from('refresh_state_references')
                    .where('source_key', options.sourceKey)
                    .whereIn('target_entity_ref', refs)
                    .union(function recursive(inner) {
                      return inner
                        .select({
                          root_id: 'descendants.root_id',
                          entity_ref:
                            'refresh_state_references.target_entity_ref',
                        })
                        .from('descendants')
                        .join('refresh_state_references', {
                          'descendants.entity_ref':
                            'refresh_state_references.source_entity_ref',
                        });
                    });
                })
                // All the nodes that can be reached upwards from the descendants
                .withRecursive('ancestors', function ancestors(outer) {
                  return outer
                    .select({
                      root_id: rootId(),
                      via_entity_ref: 'entity_ref',
                      to_entity_ref: 'entity_ref',
                    })
                    .from('descendants')
                    .union(function recursive(inner) {
                      return inner
                        .select({
                          root_id: tx.raw(
                            'CASE WHEN source_key IS NOT NULL THEN id ELSE NULL END',
                            [],
                          ),
                          via_entity_ref: 'source_entity_ref',
                          to_entity_ref: 'ancestors.to_entity_ref',
                        })
                        .from('ancestors')
                        .join('refresh_state_references', {
                          target_entity_ref: 'ancestors.via_entity_ref',
                        });
                    });
                })
                // Start out with all of the descendants
                .select('descendants.entity_ref')
                .from('descendants')
                // Expand with all ancestors that point to those, but aren't the current root
                .leftOuterJoin('ancestors', function keepaliveRoots() {
                  this.on(
                    'ancestors.to_entity_ref',
                    '=',
                    'descendants.entity_ref',
                  );
                  this.andOnNotNull('ancestors.root_id');
                  this.andOn('ancestors.root_id', '!=', 'descendants.root_id');
                })
                .whereNull('ancestors.root_id')
            );
          })
          .delete();

        await tx<DbRefreshStateReferencesRow>('refresh_state_references')
          .where('source_key', '=', options.sourceKey)
          .whereIn('target_entity_ref', refs)
          .delete();
      }

      this.options.logger.debug(
        `removed, ${removedCount} entities: ${JSON.stringify(toRemove)}`,
      );
    }

    if (toAdd.length) {
      // The reason for this chunking, rather than just massively batch
      // inserting the entire payload, is that we fall back to the individual
      // upsert mechanism below on conflicts. That path is massively slower than
      // the fast batch path, so we don't want to end up accidentally having to
      // for example item-by-item upsert tens of thousands of entities in a
      // large initial delivery dump. The implication is that the size of these
      // chunks needs to weigh the benefit of fast successful inserts, against
      // the drawback of super slow but more rare fallbacks. There's quickly
      // diminishing returns though with turning up this value way high.
      for (const chunk of lodash.chunk(toAdd, 50)) {
        try {
          await tx.batchInsert(
            'refresh_state',
            chunk.map(item => ({
              entity_id: uuid(),
              entity_ref: stringifyEntityRef(item.deferred.entity),
              unprocessed_entity: JSON.stringify(item.deferred.entity),
              unprocessed_hash: item.hash,
              errors: '',
              location_key: item.deferred.locationKey,
              next_update_at: tx.fn.now(),
              last_discovery_at: tx.fn.now(),
            })),
            BATCH_SIZE,
          );
          await tx.batchInsert(
            'refresh_state_references',
            chunk.map(item => ({
              source_key: options.sourceKey,
              target_entity_ref: stringifyEntityRef(item.deferred.entity),
            })),
            BATCH_SIZE,
          );
        } catch (error) {
          if (!isDatabaseConflictError(error)) {
            throw error;
          } else {
            this.options.logger.debug(
              `Fast insert path failed, falling back to slow path, ${error}`,
            );
            toUpsert.push(...chunk);
          }
        }
      }
    }

    if (toUpsert.length) {
      for (const {
        deferred: { entity, locationKey },
        hash,
      } of toUpsert) {
        const entityRef = stringifyEntityRef(entity);

        try {
          let ok = await updateUnprocessedEntity(tx, entity, hash, locationKey);
          if (!ok) {
            ok = await insertUnprocessedEntity(
              tx,
              entity,
              hash,
              this.options.logger,
              locationKey,
            );
          }

          if (ok) {
            await tx<DbRefreshStateReferencesRow>(
              'refresh_state_references',
            ).insert({
              source_key: options.sourceKey,
              target_entity_ref: entityRef,
            });
          } else {
            const conflictingKey = await checkLocationKeyConflict(
              tx,
              entityRef,
              locationKey,
            );
            if (conflictingKey) {
              this.options.logger.warn(
                `Source ${options.sourceKey} detected conflicting entityRef ${entityRef} already referenced by ${conflictingKey} and now also ${locationKey}`,
              );
            }
          }
        } catch (error) {
          this.options.logger.error(
            `Failed to add '${entityRef}' from source '${options.sourceKey}', ${error}`,
          );
        }
      }
    }
  }

  async refreshByRefreshKeys(
    txOpaque: Transaction,
    options: RefreshByKeyOptions,
  ) {
    const tx = txOpaque as Knex.Transaction;
    const { keys } = options;

    await tx<DbRefreshStateRow>('refresh_state')
      .whereIn('entity_id', function selectEntityRefs(tx2) {
        tx2
          .whereIn('key', keys)
          .select({
            entity_id: 'refresh_keys.entity_id',
          })
          .from('refresh_keys');
      })
      .update({ next_update_at: tx.fn.now() });
  }

  private async createDelta(
    tx: Knex.Transaction,
    options: ReplaceUnprocessedEntitiesOptions,
  ): Promise<{
    toAdd: { deferred: DeferredEntity; hash: string }[];
    toUpsert: { deferred: DeferredEntity; hash: string }[];
    toRemove: string[];
  }> {
    if (options.type === 'delta') {
      return {
        toAdd: [],
        toUpsert: options.added.map(e => ({
          deferred: e,
          hash: generateStableHash(e.entity),
        })),
        toRemove: options.removed.map(e => e.entityRef),
      };
    }

    // Grab all of the existing references from the same source, and their locationKeys as well
    const oldRefs = await tx<DbRefreshStateReferencesRow>(
      'refresh_state_references',
    )
      .leftJoin<DbRefreshStateRow>('refresh_state', {
        target_entity_ref: 'entity_ref',
      })
      .where({ source_key: options.sourceKey })
      .select({
        target_entity_ref: 'refresh_state_references.target_entity_ref',
        location_key: 'refresh_state.location_key',
        unprocessed_hash: 'refresh_state.unprocessed_hash',
      });

    const items = options.items.map(deferred => ({
      deferred,
      ref: stringifyEntityRef(deferred.entity),
      hash: generateStableHash(deferred.entity),
    }));

    const oldRefsSet = new Map(
      oldRefs.map(r => [
        r.target_entity_ref,
        {
          locationKey: r.location_key,
          oldEntityHash: r.unprocessed_hash,
        },
      ]),
    );
    const newRefsSet = new Set(items.map(item => item.ref));

    const toAdd = new Array<{ deferred: DeferredEntity; hash: string }>();
    const toUpsert = new Array<{ deferred: DeferredEntity; hash: string }>();
    const toRemove = oldRefs
      .map(row => row.target_entity_ref)
      .filter(ref => !newRefsSet.has(ref));

    for (const item of items) {
      const oldRef = oldRefsSet.get(item.ref);
      const upsertItem = { deferred: item.deferred, hash: item.hash };
      if (!oldRef) {
        // Add any entity that does not exist in the database
        toAdd.push(upsertItem);
      } else if (
        (oldRef?.locationKey ?? undefined) !==
        (item.deferred.locationKey ?? undefined)
      ) {
        // Remove and then re-add any entity that exists, but with a different location key
        toRemove.push(item.ref);
        toAdd.push(upsertItem);
      } else if (oldRef.oldEntityHash !== item.hash) {
        // Entities with modifications should be pushed through too
        toUpsert.push(upsertItem);
      }
    }

    return { toAdd, toUpsert, toRemove };
  }
}
