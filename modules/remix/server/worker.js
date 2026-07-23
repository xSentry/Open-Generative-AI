import { requireAsset, requireJob } from './repo.js';
import { processFrameEdit, processPrepareVideo, processVideoEdit } from './processors.js';

export async function processRemixQueueJob(data) {
  const job = await requireJob(data.jobId, data.projectId, data.userId);
  if (job.status === 'canceled' || job.status === 'succeeded') return null;
  if (data.type === 'prepare-video') {
    const sourceAsset = await requireAsset(data.subjectId, data.projectId, data.userId, ['source_video']);
    return processPrepareVideo({
      projectId: data.projectId, userId: data.userId, sourceAsset, job,
    });
  }
  if (data.type === 'edit-frame') {
    return processFrameEdit({
      projectId: data.projectId, userId: data.userId, frameEditId: data.subjectId, job,
    });
  }
  if (data.type === 'edit-video') {
    return processVideoEdit({
      projectId: data.projectId, userId: data.userId, versionId: data.subjectId, job,
    });
  }
  throw new Error(`Unknown Remix job type "${data.type}".`);
}
