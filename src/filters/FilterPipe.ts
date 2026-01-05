import { ExtensionType } from '../extensions/Extensions';

import type { InstructionSet } from '../rendering/renderers/shared/instructions/InstructionSet';
import type { InstructionPipe } from '../rendering/renderers/shared/instructions/RenderPipe';
import type { Renderer } from '../rendering/renderers/types';
import type { Container } from '../scene/container/Container';
import type { Effect } from '../scene/container/Effect';
import type { FilterInstruction } from './FilterSystem';

/** @internal */
export class FilterPipe implements InstructionPipe<FilterInstruction>
{
    public static extension = {
        type: [
            ExtensionType.WebGLPipes,
            ExtensionType.WebGPUPipes,
            ExtensionType.CanvasPipes,
        ],
        name: 'filter',
    } as const;

    #renderer: Renderer;

    constructor(renderer: Renderer)
    {
        this.#renderer = renderer;
    }

    public push(filterEffect: Effect, container: Container, instructionSet: InstructionSet): void
    {
        const renderPipes = this.#renderer.renderPipes;

        renderPipes.batch.break(instructionSet);

        instructionSet.add({
            renderPipeId: 'filter',
            canBundle: false,
            action: 'pushFilter',
            container,
            filterEffect,
        } as FilterInstruction);
    }

    public pop(_filterEffect: Effect, _container: Container, instructionSet: InstructionSet): void
    {
        this.#renderer.renderPipes.batch.break(instructionSet);

        instructionSet.add({
            renderPipeId: 'filter',
            action: 'popFilter',
            canBundle: false,
        });
    }

    public execute(instruction: FilterInstruction)
    {
        if (instruction.action === 'pushFilter')
        {
            this.#renderer.filter.push(instruction);
        }
        else if (instruction.action === 'popFilter')
        {
            this.#renderer.filter.pop();
        }
    }

    public destroy(): void
    {
        this.#renderer = null;
    }
}
