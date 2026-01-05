import CheckImageBitmapWorker from 'worker:./checkImageBitmap.worker.ts';
import LoadImageBitmapWorker from 'worker:./loadImageBitmap.worker.ts';

import type { TextureSourceOptions } from '../../../rendering/renderers/shared/texture/sources/TextureSource';
import type { ResolvedAsset } from '../../types';

let UUID = 0;
let MAX_WORKERS: number;

type LoadImageBitmapResult = {
    data?: ImageBitmap,
    error?: Error,
    uuid: number,
    id: string,
};

/** @internal */
class WorkerManagerClass
{
    /**
     * Hash map storing resolve/reject functions for pending worker requests.
     * Keyed by UUID to match responses with their corresponding promises.
     */
    #resolveHash: {
        [key: string]: {
            resolve: (...param: any[]) => void;
            reject: (...param: any[]) => void;
        }
    };
    /** Pool of available workers ready for use */
    readonly #workerPool: Worker[];
    /** Queue of pending work items waiting for available workers */
    readonly #queue: {
        id: string;
        arguments: any[];
        resolve: (...param: any[]) => void;
        reject: (...param: any[]) => void;
    }[];

    /** Whether the worker manager has been initialized */
    #initialized = false;

    /** Current number of created workers (used to enforce MAX_WORKERS limit) */
    #createdWorkers = 0;
    /** Cached promise for ImageBitmap support check */
    #isImageBitmapSupported?: Promise<boolean>;

    constructor()
    {
        this.#workerPool = [];
        this.#queue = [];

        this.#resolveHash = {};
    }

    /**
     * Checks if ImageBitmap is supported in the current environment.
     *
     * This method uses a dedicated worker to test ImageBitmap support
     * and caches the result for subsequent calls.
     * @returns Promise that resolves to true if ImageBitmap is supported, false otherwise
     */
    public isImageBitmapSupported(): Promise<boolean>
    {
        if (this.#isImageBitmapSupported !== undefined) return this.#isImageBitmapSupported;

        this.#isImageBitmapSupported = new Promise((resolve) =>
        {
            const { worker } = new CheckImageBitmapWorker();

            worker.addEventListener('message', (event: MessageEvent<boolean>) =>
            {
                worker.terminate();
                CheckImageBitmapWorker.revokeObjectURL();
                resolve(event.data);
            });
        });

        return this.#isImageBitmapSupported;
    }

    /**
     * Loads an image as an ImageBitmap using a web worker.
     * @param src - The source URL or path of the image to load
     * @param asset - Optional resolved asset containing additional texture source options
     * @returns Promise that resolves to the loaded ImageBitmap
     * @example
     * ```typescript
     * const bitmap = await WorkerManager.loadImageBitmap('image.png');
     * const bitmapWithOptions = await WorkerManager.loadImageBitmap('image.png', asset);
     * ```
     */
    public loadImageBitmap(src: string, asset?: ResolvedAsset<TextureSourceOptions<any>>): Promise<ImageBitmap>
    {
        return this.#run('loadImageBitmap', [src, asset?.data?.alphaMode]) as Promise<ImageBitmap>;
    }

    /**
     * Initializes the worker pool if not already initialized.
     * Currently a no-op but reserved for future initialization logic.
     */
    async #initWorkers()
    {
        if (this.#initialized) return;

        this.#initialized = true;
    }

    /**
     * Gets an available worker from the pool or creates a new one if needed.
     *
     * Workers are created up to the MAX_WORKERS limit (based on navigator.hardwareConcurrency).
     * Each worker is configured with a message handler for processing results.
     * @returns Available worker or undefined if pool is at capacity and no workers are free
     */
    #getWorker(): Worker
    {
        if (MAX_WORKERS === undefined)
        {
            MAX_WORKERS = navigator.hardwareConcurrency || 4;
        }
        let worker = this.#workerPool.pop();

        if (!worker && this.#createdWorkers < MAX_WORKERS)
        {
            // only create as many as MAX_WORKERS allows..
            this.#createdWorkers++;
            worker = new LoadImageBitmapWorker().worker;

            worker.addEventListener('message', (event: MessageEvent) =>
            {
                this.#complete(event.data);

                this.#returnWorker(event.target as Worker);
                this.#next();
            });
        }

        return worker;
    }

    /**
     * Returns a worker to the pool after completing a task.
     * @param worker - The worker to return to the pool
     */
    #returnWorker(worker: Worker)
    {
        this.#workerPool.push(worker);
    }

    /**
     * Handles completion of a worker task by resolving or rejecting the corresponding promise.
     * @param data - Result data from the worker containing uuid, data, and optional error
     */
    #complete(data: LoadImageBitmapResult): void
    {
        if (!this.#resolveHash[data.uuid])
        {
            // this can happen if the worker manager is reset before a task completes
            return;
        }

        if (data.error !== undefined)
        {
            this.#resolveHash[data.uuid].reject(data.error);
        }
        else
        {
            this.#resolveHash[data.uuid].resolve(data.data);
        }

        delete this.#resolveHash[data.uuid];
    }

    /**
     * Executes a task using the worker pool system.
     *
     * Queues the task and processes it when a worker becomes available.
     * @param id - Identifier for the type of task to run
     * @param args - Arguments to pass to the worker
     * @returns Promise that resolves with the worker's result
     */
    async #run(id: string, args: any[]): Promise<any>
    {
        await this.#initWorkers();
        // push into the queue...

        const promise = new Promise((resolve, reject) =>
        {
            this.#queue.push({ id, arguments: args, resolve, reject });
        });

        this.#next();

        return promise;
    }

    /**
     * Processes the next item in the queue if workers are available.
     *
     * This method is called after worker initialization and when workers
     * complete tasks to continue processing the queue.
     */
    #next(): void
    {
        // nothing to do
        if (!this.#queue.length) return;

        const worker = this.#getWorker();

        // no workers available...
        if (!worker)
        {
            return;
        }

        const toDo = this.#queue.pop();

        const id = toDo.id;

        this.#resolveHash[UUID] = { resolve: toDo.resolve, reject: toDo.reject };

        worker.postMessage({
            data: toDo.arguments,
            uuid: UUID++,
            id,
        });
    }

    /**
     * Resets the worker manager, terminating all workers and clearing the queue.
     *
     * This method:
     * - Terminates all active workers
     * - Rejects all pending promises with an error
     * - Clears all internal state
     * - Resets initialization flags
     *
     * This should be called when the worker manager is no longer needed
     * to prevent memory leaks and ensure proper cleanup.
     * @example
     * ```typescript
     * // Clean up when shutting down
     * WorkerManager.reset();
     * ```
     */
    public reset(): void
    {
        // Terminate all workers
        this.#workerPool.forEach((worker) => worker.terminate());
        this.#workerPool.length = 0;

        // Reject pending promises
        Object.values(this.#resolveHash).forEach(({ reject }) =>
        {
            reject?.(new Error('WorkerManager has been reset before completion'));
        });
        this.#resolveHash = {};
        this.#queue.length = 0;

        this.#initialized = false;
        this.#createdWorkers = 0;
    }
}

/**
 * Manages a pool of web workers for loading ImageBitmap objects asynchronously.
 *
 * This class provides a thread-safe way to load images using web workers,
 * automatically managing worker creation, pooling, and cleanup. It supports
 * checking ImageBitmap support and queuing multiple load requests.
 *
 * > [!IMPORTANT] You should not need to use this class directly
 * > However, you can call `WorkerManager.reset()` to clean up all workers when they are no longer needed.
 * @category Assets
 * @advanced
 */
const WorkerManager = new WorkerManagerClass();

export {
    WorkerManager,
};
