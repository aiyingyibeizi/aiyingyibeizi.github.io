import { createClient } from '@supabase/supabase-js';
import type { Env } from '../types/env';

const BUCKET_NAME = 'files';

export async function uploadFile(env: Env, userId: string, file: File): Promise<string> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const path = `${userId}/${Date.now()}-${file.name}`;

  const { data, error } = await supabase.storage.from(BUCKET_NAME).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });

  if (error) {
    console.error('Supabase Storage upload error:', error);
    throw new Error(`Upload failed: ${error.message}`);
  }

  const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(data.path);
  return publicUrlData.publicUrl;
}
