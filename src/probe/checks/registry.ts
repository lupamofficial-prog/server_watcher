import type { CheckTypeName } from '../../shared/contracts';
import { NetworkCheck } from './network';
import { XrayE2ECheck } from './xray';
import type { CheckStrategy } from './types';

const strategies = new Map<CheckTypeName, CheckStrategy>();
for (const s of [new NetworkCheck(), new XrayE2ECheck()]) strategies.set(s.type, s);

export const getStrategy = (t: CheckTypeName) => strategies.get(t);
