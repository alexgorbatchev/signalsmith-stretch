declare function SignalsmithStretch(
  context: BaseAudioContext,
  options?: AudioWorkletNodeOptions,
): Promise<SignalsmithStretch.IStretchNode>;

declare namespace SignalsmithStretch {
  let moduleUrl: string | undefined;
  function decodeOutputHistory(message: unknown): IHistorySegment[];

  interface IOutputHistoryOptions {
    maxFrames: number;
    maxRecords: number;
    maxReplyRecords: number;
  }

  interface ISourceDescription {
    readonly generation: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly lengthFrames: number | null;
    readonly capacityFrames: number;
    readonly outputHistory?: IOutputHistoryOptions;
  }

  interface ILoop {
    start: number;
    end: number;
  }

  interface ISourceRange {
    start: number;
    end: number;
  }

  interface ICommand {
    id: number;
    atFrame: number;
    position?: number;
    active?: boolean;
    rate?: number;
    semitones?: number;
    loop?: ILoop | null;
  }

  interface ISchedule {
    active?: boolean;
    input?: number;
    output?: number;
    outputTime?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  }

  interface IScheduledState extends Required<Omit<ISchedule, "outputTime">> {}

  interface IConfiguration {
    preset?: "default" | "cheaper";
    blockMs?: number | null;
    intervalMs?: number;
    splitComputation?: boolean;
  }

  interface IBufferExtent {
    start: number;
    end: number;
  }

  interface IStretchNode extends AudioWorkletNode {
    inputTime: number;
    attachSource(spec: ISourceDescription, port: MessagePort, transfer?: Transferable[]): Promise<ISourceDescription>;
    detachSource(): Promise<void>;
    configure(config: IConfiguration): Promise<void>;
    latency(): Promise<number>;
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<void>;
    start(when?: number, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<IScheduledState>;
    start(schedule: ISchedule): Promise<IScheduledState>;
    stop(when?: number): Promise<IScheduledState>;
    schedule(schedule: ISchedule, adjustPrevious?: boolean): Promise<IScheduledState>;
    addBuffers(channels: Float32Array | Float32Array[], transfer?: Transferable[]): Promise<number>;
    dropBuffers(toSeconds?: number, transfer?: Transferable[]): Promise<IBufferExtent>;
  }

  interface IMessageIdentity {
    generation: string;
    requestId?: unknown;
  }

  interface IWindowMessage extends IMessageIdentity {
    type: "window";
    start: number;
    channels: Float32Array<ArrayBuffer>[];
    endFrame?: number;
  }

  interface IEofMessage extends IMessageIdentity {
    type: "eof";
    endFrame: number;
  }

  interface IDropMessage extends IMessageIdentity {
    type: "drop";
    starts: number[];
  }

  interface ICommandMessage extends IMessageIdentity {
    type: "command";
    command: ICommand;
  }

  interface IReadFailedMessage extends IMessageIdentity {
    type: "read-failed";
  }

  interface IRetryMessage extends IMessageIdentity {
    type: "retry";
  }

  interface IObserveOutputMessage extends IMessageIdentity {
    type: "observe-output";
  }

  interface IObserveHistoryMessage extends IMessageIdentity {
    type: "observe-history";
    requestId: string | number;
    fromFrame: number;
  }

  interface ICancelObserveHistoryMessage extends IMessageIdentity {
    type: "cancel-observe-history";
    requestId: string | number;
    observationRequestId: string | number;
  }

  interface IHistorySegment {
    fromFrame: number;
    toFrame: number;
    sourceFrame: number | null;
    rate: number | null;
    loop: ILoop | null;
    status: "playing" | "draining" | "paused" | "preparing" | "underrun" | "source-error" | "ended";
    ended: boolean;
  }

  interface IOutputHistoryMessage extends IMessageIdentity {
    type: "output-history";
    fromFrame: number;
    generationStartFrame: number | null;
    oldestRetainedFrame: number | null;
    renderedThroughFrame: number | null;
    returnedThroughFrame: number | null;
    preGenerationThroughFrame: number | null;
    truncatedBeforeFrame: number | null;
    records: Float64Array<ArrayBuffer>;
  }

  interface IHistoryQueuedMessage extends IMessageIdentity {
    type: "history-queued";
  }

  interface IHistoryCancelledMessage extends IMessageIdentity {
    type: "history-cancelled";
  }

  type WorkerMessage = IWindowMessage | IEofMessage | IDropMessage | ICommandMessage | IReadFailedMessage | IRetryMessage | IObserveOutputMessage | IObserveHistoryMessage | ICancelObserveHistoryMessage;

  interface IOutputSegment {
    fromFrame: number;
    toFrame: number;
    sourceFrame: number;
    rate: number;
    loop: ILoop | null;
  }

  interface IObservation {
    renderFrame: number;
    renderedThroughFrame: number;
    validFrom: number;
    validTo: number;
    sourceFrame: number | null;
    nextSourceFrame: number;
    processingSourceFrame: number;
    acceptedRate: number;
    acceptedSemitones: number;
    acceptedLoop: ILoop | null;
    outputRate: number | null;
    outputSegments: IOutputSegment[];
    active: boolean;
    lengthFrames: number | null;
    ended: boolean;
    status: "paused" | "preparing" | "playing" | "draining" | "underrun" | "source-error";
    inputLatencyFrames: number;
    outputLatencyFrames: number;
  }

  interface IStateMessage extends IMessageIdentity, IObservation {
    type: "state";
  }

  interface IOutputObservationMessage extends IMessageIdentity, IObservation {
    type: "output-observation";
  }

  interface IObservationQueuedMessage extends IMessageIdentity {
    type: "observation-queued";
  }

  interface IAppliedMessage extends IMessageIdentity, IObservation {
    type: "applied";
    commandId: number;
    superseded: boolean;
    effectiveOutputFrame: number | null;
  }

  interface INeedMessage extends IMessageIdentity {
    type: "need";
    range: ISourceRange;
    retain: ISourceRange[];
    required: boolean;
    renderFrame: number;
    processingSourceFrame: number;
  }

  interface IReadyMessage extends IMessageIdentity {
    type: "source-ready";
    description: ISourceDescription;
  }

  interface IAcceptedMessage extends IMessageIdentity, ISourceRange {
    type: "window-accepted";
    residentFrames: number;
    lengthFrames: number | null;
  }

  interface IEofAcceptedMessage extends IMessageIdentity {
    type: "eof-accepted";
    lengthFrames: number;
  }

  interface IReleasedMessage extends IMessageIdentity {
    type: "released";
    residentFrames: number;
    buffers: ArrayBuffer[];
  }

  interface IClosedMessage extends IMessageIdentity {
    type: "source-closed";
    reason: string;
    buffers: ArrayBuffer[];
  }

  interface IQueuedMessage extends IMessageIdentity {
    type: "queued";
    commandId: number;
  }

  interface IRejectedMessage extends IMessageIdentity {
    type: "rejected";
    code: string;
  }

  interface IFailureMessage extends IMessageIdentity {
    type: "read-failed";
    code: "source_read_failed";
  }

  interface IRetriedMessage extends IMessageIdentity {
    type: "retry-accepted";
  }

  type WorkletMessage = IStateMessage | IAppliedMessage | INeedMessage | IReadyMessage | IAcceptedMessage
    | IEofAcceptedMessage | IReleasedMessage | IClosedMessage | IQueuedMessage | IRejectedMessage | IFailureMessage
    | IRetriedMessage | IOutputObservationMessage | IObservationQueuedMessage | IOutputHistoryMessage
    | IHistoryQueuedMessage | IHistoryCancelledMessage;
}
export = SignalsmithStretch;
