const { cpSync, existsSync, mkdirSync, rmSync } = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const sourceDir = path.join(projectRoot, 'release', 'win-unpacked')
const distRoot = path.join(projectRoot, 'dist')
const targetDir = path.join(distRoot, 'Sound-Stitch-Windows')
const executable = path.join(sourceDir, 'Sound Stitch.exe')
const readme = path.join(projectRoot, 'DISTRIBUTION_README.txt')

if (!existsSync(executable)) {
  throw new Error('배포할 Sound Stitch.exe가 없습니다. 먼저 pnpm dist를 실행하세요.')
}

if (!existsSync(readme)) {
  throw new Error(`배포 안내 파일을 찾을 수 없습니다: ${readme}`)
}

// Electron 앱은 EXE와 resources 폴더가 함께 있어야 하므로 전체 폴더를 복사한다.
rmSync(targetDir, { recursive: true, force: true })
mkdirSync(distRoot, { recursive: true })
cpSync(sourceDir, targetDir, { recursive: true })
cpSync(readme, path.join(targetDir, 'README.txt'))

console.log(`Windows 배포 폴더 준비 완료: ${targetDir}`)
console.log('이 폴더 안의 Sound Stitch.exe를 실행하세요.')
