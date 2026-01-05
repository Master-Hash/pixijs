import { type Renderer } from '../rendering/renderers/types';
import { UPDATE_PRIORITY } from '../ticker/const';
import { Ticker } from '../ticker/Ticker';

/**
 * CanvasObserver class synchronizes the DOM element's transform with the canvas size and position.
 * It uses ResizeObserver for efficient updates and requestAnimationFrame for fallback.
 * This ensures that the DOM element is always correctly positioned and scaled relative to the canvas.
 * @internal
 */
export class CanvasObserver
{
    /** A cached value of the last transform applied to the DOM element. */
    #lastTransform = '';
    /** A ResizeObserver instance to observe changes in the canvas size. */
    #observer: ResizeObserver | null = null;
    /** The canvas element that this observer is associated with. */
    #canvas: HTMLCanvasElement;
    /** The DOM element that will be transformed based on the canvas size and position. */
    readonly #domElement: HTMLElement;
    /** The renderer instance that this observer is associated with. */
    readonly #renderer: Renderer;
    /** The last scale values applied to the DOM element, used to avoid unnecessary updates. */
    #lastScaleX: number;
    /** The last scale values applied to the DOM element, used to avoid unnecessary updates. */
    #lastScaleY: number;
    /** A flag to indicate whether the observer is attached to the Ticker for continuous updates. */
    #tickerAttached = false;

    constructor(options: { domElement: HTMLElement; renderer: Renderer })
    {
        this.#domElement = options.domElement;
        this.#renderer = options.renderer;

        // We need to ensure that the canvas is not an OffscreenCanvas
        if (globalThis.OffscreenCanvas && this.#renderer.canvas instanceof OffscreenCanvas) return;
        this.#canvas = this.#renderer.canvas;
        this.#attachObserver();
    }

    /** The canvas element that this CanvasObserver is associated with. */
    public get canvas(): HTMLCanvasElement
    {
        return this.#canvas;
    }

    /** Attaches the DOM element to the canvas parent if it is not already attached. */
    public ensureAttached()
    {
        if (!this.#domElement.parentNode && this.#canvas.parentNode)
        {
            this.#canvas.parentNode.appendChild(this.#domElement);
            this.updateTranslation();
        }
    }

    /**
     * Updates the transform of the DOM element based on the canvas size and position.
     * This method calculates the scale and translation needed to keep the DOM element in sync with the canvas.
     */
    public readonly updateTranslation = () =>
    {
        if (!this.#canvas) return;

        const rect = this.#canvas.getBoundingClientRect(); // still needed for left/top
        const contentWidth = this.#canvas.width;
        const contentHeight = this.#canvas.height;

        const sx = (rect.width / contentWidth) * this.#renderer.resolution;
        const sy = (rect.height / contentHeight) * this.#renderer.resolution;
        const tx = rect.left;
        const ty = rect.top;

        const newTransform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;

        if (newTransform !== this.#lastTransform)
        {
            this.#domElement.style.transform = newTransform;
            this.#lastTransform = newTransform;
        }
    };

    /** Sets up a ResizeObserver if available. This ensures that the DOM element is kept in sync with the canvas size . */
    #attachObserver()
    {
        if ('ResizeObserver' in globalThis)
        {
            if (this.#observer)
            {
                this.#observer.disconnect();
                this.#observer = null;
            }

            this.#observer = new ResizeObserver((entries) =>
            {
                for (const entry of entries)
                {
                    if (entry.target !== this.#canvas)
                    {
                        continue;
                    }

                    const contentWidth = this.canvas.width;
                    const contentHeight = this.canvas.height;
                    const sx = (entry.contentRect.width / contentWidth) * this.#renderer.resolution;
                    const sy = (entry.contentRect.height / contentHeight) * this.#renderer.resolution;

                    // Only refetch position if scale actually changed
                    const needsUpdate = this.#lastScaleX !== sx || this.#lastScaleY !== sy;

                    if (needsUpdate)
                    {
                        this.updateTranslation(); // safely fetch `left` and `top` only when needed
                        this.#lastScaleX = sx;
                        this.#lastScaleY = sy;
                    }
                }
            });
            this.#observer.observe(this.#canvas);
        }
        else if (!this.#tickerAttached)
        {
            Ticker.shared.add(this.updateTranslation, this, UPDATE_PRIORITY.HIGH);
        }
    }

    /** Destroys the CanvasObserver instance, cleaning up observers and Ticker. */
    public destroy()
    {
        if (this.#observer)
        {
            this.#observer.disconnect();
            this.#observer = null;
        }
        else if (this.#tickerAttached)
        {
            Ticker.shared.remove(this.updateTranslation);
        }

        (this.#domElement as null) = null;
        (this.#renderer as null) = null;
        this.#canvas = null;
        this.#tickerAttached = false;
        this.#lastTransform = '';
        this.#lastScaleX = null;
        this.#lastScaleY = null;
    }
}
