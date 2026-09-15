import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../types/env';

const BUCKET_NAME = 'files';

// 修复：客户端复用（此前每个上传请求都新建 Supabase 客户端）
let cachedClient: SupabaseClient | null = null;

function getClient(env: Env): SupabaseClient {
  if (!cachedClient) {
    cachedClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return cachedClient;
}

/** 清洗文件名：剥离路径分隔符与特殊字符（修复 file.name 直接拼路径的路径注入风险） */
function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() || 'file';
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 120);
  return cleaned || 'file';
}

export async function uploadFile(env: Env, userId: string, file: File): Promise<string> {
  const supabase = getClient(env);
  const safeUserId = userId.replace(/[^\w.-]/g, '_');
  const path = `${safeUserId}/${Date.now()}-${sanitizeFileName(file.name)}`;

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
