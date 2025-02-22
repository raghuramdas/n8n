import { mock } from 'jest-mock-extended';
import type {
	IExecuteResponsePromiseData,
	IRun,
	IWorkflowExecutionDataProcess,
} from 'n8n-workflow';
import { createDeferredPromise } from 'n8n-workflow';
import PCancelable from 'p-cancelable';
import { v4 as uuid } from 'uuid';

import { ActiveExecutions } from '@/active-executions';
import { ConcurrencyControlService } from '@/concurrency/concurrency-control.service';
import type { ExecutionRepository } from '@/databases/repositories/execution.repository';
import { mockInstance } from '@test/mocking';

const FAKE_EXECUTION_ID = '15';
const FAKE_SECOND_EXECUTION_ID = '20';

const updateExistingExecution = jest.fn();
const createNewExecution = jest.fn(async () => FAKE_EXECUTION_ID);

const executionRepository = mock<ExecutionRepository>({
	updateExistingExecution,
	createNewExecution,
});

const concurrencyControl = mockInstance(ConcurrencyControlService, {
	// @ts-expect-error Private property
	isEnabled: false,
});

describe('ActiveExecutions', () => {
	let activeExecutions: ActiveExecutions;

	beforeEach(() => {
		activeExecutions = new ActiveExecutions(mock(), executionRepository, concurrencyControl);
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	test('Should initialize activeExecutions with empty list', () => {
		expect(activeExecutions.getActiveExecutions()).toHaveLength(0);
	});

	test('Should add execution to active execution list', async () => {
		const newExecution = mockExecutionData();
		const executionId = await activeExecutions.add(newExecution);

		expect(executionId).toBe(FAKE_EXECUTION_ID);
		expect(activeExecutions.getActiveExecutions()).toHaveLength(1);
		expect(createNewExecution).toHaveBeenCalledTimes(1);
		expect(updateExistingExecution).toHaveBeenCalledTimes(0);
	});

	test('Should update execution if add is called with execution ID', async () => {
		const newExecution = mockExecutionData();
		const executionId = await activeExecutions.add(newExecution, FAKE_SECOND_EXECUTION_ID);

		expect(executionId).toBe(FAKE_SECOND_EXECUTION_ID);
		expect(activeExecutions.getActiveExecutions()).toHaveLength(1);
		expect(createNewExecution).toHaveBeenCalledTimes(0);
		expect(updateExistingExecution).toHaveBeenCalledTimes(1);
	});

	test('Should fail attaching execution to invalid executionId', async () => {
		const deferredPromise = mockCancelablePromise();

		expect(() => {
			activeExecutions.attachWorkflowExecution(FAKE_EXECUTION_ID, deferredPromise);
		}).toThrow();
	});

	test('Should successfully attach execution to valid executionId', async () => {
		const newExecution = mockExecutionData();
		await activeExecutions.add(newExecution, FAKE_EXECUTION_ID);
		const deferredPromise = mockCancelablePromise();

		expect(() =>
			activeExecutions.attachWorkflowExecution(FAKE_EXECUTION_ID, deferredPromise),
		).not.toThrow();
	});

	test('Should attach and resolve response promise to existing execution', async () => {
		const newExecution = mockExecutionData();
		await activeExecutions.add(newExecution, FAKE_EXECUTION_ID);
		const deferredPromise = mockDeferredPromise();
		activeExecutions.attachResponsePromise(FAKE_EXECUTION_ID, deferredPromise);
		const fakeResponse = { data: { resultData: { runData: {} } } };
		activeExecutions.resolveResponsePromise(FAKE_EXECUTION_ID, fakeResponse);

		await expect(deferredPromise.promise).resolves.toEqual(fakeResponse);
	});

	test('Should copy over startedAt and responsePromise when resuming a waiting execution', async () => {
		const newExecution = mockExecutionData();
		const executionId = await activeExecutions.add(newExecution);
		activeExecutions.setStatus(executionId, 'waiting');
		activeExecutions.attachResponsePromise(executionId, mockDeferredPromise());

		const waitingExecution = activeExecutions.getExecution(executionId);
		expect(waitingExecution.responsePromise).toBeDefined();

		// Resume the execution
		await activeExecutions.add(newExecution, executionId);

		const resumedExecution = activeExecutions.getExecution(executionId);
		expect(resumedExecution.startedAt).toBe(waitingExecution.startedAt);
		expect(resumedExecution.responsePromise).toBe(waitingExecution.responsePromise);
	});

	test('Should not remove a waiting execution', async () => {
		const newExecution = mockExecutionData();
		const executionId = await activeExecutions.add(newExecution);
		activeExecutions.setStatus(executionId, 'waiting');
		activeExecutions.finalizeExecution(executionId);

		// Wait until the next tick to ensure that the post-execution promise has settled
		await new Promise(setImmediate);

		// Execution should still be in activeExecutions
		expect(activeExecutions.getActiveExecutions()).toHaveLength(1);
		expect(activeExecutions.getStatus(executionId)).toBe('waiting');
	});

	test('Should remove an existing execution', async () => {
		// ARRANGE
		const newExecution = mockExecutionData();
		const executionId = await activeExecutions.add(newExecution);

		// ACT
		activeExecutions.finalizeExecution(executionId);

		// Wait until the next tick to ensure that the post-execution promise has settled
		await new Promise(setImmediate);

		// ASSERT
		expect(activeExecutions.getActiveExecutions()).toHaveLength(0);
	});

	test('Should not try to resolve a post-execute promise for an inactive execution', async () => {
		const getExecutionSpy = jest.spyOn(activeExecutions, 'getExecution');

		activeExecutions.finalizeExecution('inactive-execution-id', mockFullRunData());

		expect(getExecutionSpy).not.toHaveBeenCalled();
	});

	test('Should resolve post execute promise on removal', async () => {
		const newExecution = mockExecutionData();
		const executionId = await activeExecutions.add(newExecution);
		const postExecutePromise = activeExecutions.getPostExecutePromise(executionId);
		// Force the above to be executed since we cannot await it
		await new Promise((res) => {
			setTimeout(res, 100);
		});
		const fakeOutput = mockFullRunData();
		activeExecutions.finalizeExecution(executionId, fakeOutput);

		await expect(postExecutePromise).resolves.toEqual(fakeOutput);
	});

	test('Should throw error when trying to create a promise with invalid execution', async () => {
		await expect(activeExecutions.getPostExecutePromise(FAKE_EXECUTION_ID)).rejects.toThrow();
	});

	test('Should call function to cancel execution when asked to stop', async () => {
		const newExecution = mockExecutionData();
		const executionId = await activeExecutions.add(newExecution);
		const cancelExecution = jest.fn();
		const cancellablePromise = mockCancelablePromise();
		cancellablePromise.cancel = cancelExecution;
		activeExecutions.attachWorkflowExecution(executionId, cancellablePromise);
		activeExecutions.stopExecution(executionId);

		expect(cancelExecution).toHaveBeenCalledTimes(1);
	});
});

function mockExecutionData(): IWorkflowExecutionDataProcess {
	return {
		executionMode: 'manual',
		workflowData: {
			id: '123',
			name: 'Test workflow 1',
			active: false,
			createdAt: new Date(),
			updatedAt: new Date(),
			nodes: [],
			connections: {},
		},
		userId: uuid(),
	};
}

function mockFullRunData(): IRun {
	return {
		data: {
			resultData: {
				runData: {},
			},
		},
		mode: 'manual',
		startedAt: new Date(),
		status: 'new',
	};
}

// eslint-disable-next-line @typescript-eslint/promise-function-async
const mockCancelablePromise = () => new PCancelable<IRun>((resolve) => resolve());

const mockDeferredPromise = () => createDeferredPromise<IExecuteResponsePromiseData>();
