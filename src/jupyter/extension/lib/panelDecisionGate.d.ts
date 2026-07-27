export declare function renderDecisionGate(panel: any, gate: any): void;
/** Total selectable rows = gate options + 1 trailing "type an answer" row. */
export declare function gateRowCount(panel: any): number;
/** True when the current selection is the trailing "type an answer" row. */
export declare function isGateAnswerRow(panel: any): boolean;
export declare function renderGateOptions(panel: any): void;
export declare function submitDecisionGate(panel: any): void;
export declare function cancelDecisionGate(panel: any): void;
export declare function closeDecisionGate(panel: any): void;
