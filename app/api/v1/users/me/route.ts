import { hashPassword, requireUser } from '@/lib/openwook/auth';
import { ok, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { updateCurrentUser } from '@/lib/openwook/services';
import { handleObservedRoute, isMultipartFormRequest, objectStorageHandlers } from '@/app/api/v1/_shared/route-handler';
import { profileSchema } from '@/app/api/v1/_shared/schemas';

export async function PATCH(request: Request) {
  return handleObservedRoute(request, '/api/v1/users/me', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();

    if (isMultipartFormRequest(request)) {
      const { isUploadedFile, storeAvatarFile } = await objectStorageHandlers();
      const formData = await request.formData();
      const avatarFile = formData.get('avatar');
      const avatarUrl = isUploadedFile(avatarFile)
        ? (await storeAvatarFile(user.id, avatarFile)).objectUrl
        : undefined;
      const password = String(formData.get('password') || '');
      return ok(await updateCurrentUser(user, {
        username: String(formData.get('username') || '') || undefined,
        email: String(formData.get('email') || '') || null,
        passwordHash: password ? await hashPassword(password) : undefined,
        avatarUrl
      }));
    }

    const body = profileSchema.parse(await readJson(request));
    return ok(await updateCurrentUser(user, {
      username: body.username,
      email: body.email,
      passwordHash: body.password ? await hashPassword(body.password) : undefined,
      avatarUrl: body.avatarUrl
    }));
  });
}
