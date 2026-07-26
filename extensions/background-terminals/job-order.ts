export function prioritizeActiveJobs<T>(
	jobs: readonly T[],
	isActive: (job: T) => boolean,
): T[] {
	const active: T[] = [];
	const completed: T[] = [];
	for (const job of jobs) {
		(isActive(job) ? active : completed).push(job);
	}
	return [...active, ...completed];
}
