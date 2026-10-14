import { useEffect, useMemo, useState } from 'react';

/** Freeze only list membership/order while reading. Callers always resolve the
 * keys against the latest data, and must disable actions for missing rows. */
export function useStableLiveOrder(scope: string, rankedKeys: readonly string[]) {
  const [selection, setSelection] = useState<{scope: string; keys: readonly string[]}>({scope, keys: []});
  // Populate the first nonempty result without making a user refresh an empty page.
  const initialize = selection.scope !== scope || selection.keys.length === 0 && rankedKeys.length > 0;
  const keys = initialize ? rankedKeys : selection.keys;
  useEffect(() => {
    if (initialize) setSelection({scope, keys: [...rankedKeys]});
  }, [initialize, scope, rankedKeys]);
  return useMemo(() => {
    const members = new Set(keys), latest = new Set(rankedKeys);
    const added = rankedKeys.filter(key => !members.has(key)).length;
    const removed = keys.filter(key => !latest.has(key)).length;
    const changed = keys.length !== rankedKeys.length || keys.some((key, index) => key !== rankedKeys[index]);
    return { keys, added, removed, changed };
  }, [keys, rankedKeys]);
}
