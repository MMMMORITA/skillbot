export declare function enterStepsMode(panel: any): void;
export declare function exitStepsMode(panel: any): void;
export declare function renderStepList(panel: any, steps: Array<{
    index: number;
    title: string;
    code: string;
    cell_id: string;
    status: string;
}>): void;
export declare function renderStepCard(panel: any, step: {
    index: number;
    title: string;
    code: string;
    cell_id: string;
    status: string;
}): HTMLElement;
/** ▶ Re-run just this step's cell in place (no full-chain re-run). */
export declare function rerunStep(panel: any, step: {
    cell_id: string;
}): void;
/** ⟲ Roll this step's cell back to a previous snapshot version. */
export declare function rollbackStep(panel: any, step: {
    cell_id: string;
}): void;
/** ✏️ Revise just this step — describe the change, agent rewrites this cell only. */
export declare function reviseStep(panel: any, step: {
    cell_id: string;
    code: string;
    index: number;
    title?: string;
}): Promise<void>;
export declare function showStepNotice(panel: any, msg: string): void;
