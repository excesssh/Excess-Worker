import { lstat, mkdir, mkdtemp, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const comparisonPath = value => process.platform === "win32" ? value.toLowerCase() : value;
const samePath = (left, right) => comparisonPath(resolve(left)) === comparisonPath(resolve(right));
const within = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

async function removeOwnedTree(path, ownerRoot, device) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    await rm(path);
    return;
  }
  if (info.dev !== device) throw new Error("FIXTURE_CLEANUP_PATH_ESCAPE");
  if (!info.isDirectory()) {
    await rm(path);
    return;
  }
  const actual = await realpath(path);
  if (!samePath(actual, path) || !within(ownerRoot, actual) || info.dev !== device) {
    throw new Error("FIXTURE_CLEANUP_PATH_ESCAPE");
  }
  for (const entry of await readdir(path)) await removeOwnedTree(join(path, entry), ownerRoot, device);
  await rmdir(path);
}

/** Create a disposable test directory immediately under a checked cache parent. */
export async function createFixtureScratch(prefix, parent = process.env.EXCESS_TEST_FIXTURE_CACHE ?? ".cache") {
  if (typeof prefix !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*-$/.test(prefix)) {
    throw new Error("FIXTURE_CLEANUP_PREFIX_INVALID");
  }
  const parentPath = resolve(parent);
  await mkdir(parentPath, { recursive: true });
  const parentInfo = await lstat(parentPath);
  const canonicalParent = await realpath(parentPath);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !samePath(canonicalParent, parentPath)) {
    throw new Error("FIXTURE_CLEANUP_PARENT_INVALID");
  }
  const path = await mkdtemp(join(canonicalParent, prefix));
  const canonicalPath = await realpath(path);
  const relativePath = relative(canonicalParent, canonicalPath);
  if (!samePath(path, canonicalPath) || !samePath(dirname(canonicalPath), canonicalParent) ||
      !basename(canonicalPath).startsWith(prefix) || !relativePath || relativePath.includes(sep) || relativePath === "..") {
    throw new Error("FIXTURE_CLEANUP_ROOT_INVALID");
  }
  const rootInfo = await lstat(canonicalPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("FIXTURE_CLEANUP_ROOT_INVALID");

  let removed = false;
  return Object.freeze({
    path: canonicalPath,
    async cleanup() {
      if (removed) return;
      let current;
      try {
        current = await lstat(canonicalPath);
      } catch (error) {
        if (error?.code === "ENOENT") { removed = true; return; }
        throw error;
      }
      const actual = await realpath(canonicalPath);
      if (!current.isDirectory() || current.isSymbolicLink() || !samePath(actual, canonicalPath) ||
          !samePath(dirname(actual), canonicalParent) || !basename(actual).startsWith(prefix)) {
        throw new Error("FIXTURE_CLEANUP_ROOT_INVALID");
      }
      await removeOwnedTree(actual, actual, current.dev);
      removed = true;
    },
  });
}
