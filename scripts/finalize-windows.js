const { copyFileSync, existsSync } = require('node:fs')
const path = require('node:path')

const source = require('electron')
const target = path.join(__dirname, '..', 'release', 'win-unpacked', 'Sound Stitch.exe')

if (!existsSync(source)) throw new Error(`Electron 실행 파일을 찾을 수 없습니다: ${source}`)
if (!existsSync(target)) throw new Error(`빌드된 실행 파일을 찾을 수 없습니다: ${target}`)

// 일부 Windows 앱 제어 정책은 리소스가 수정된 Electron 실행 파일을 차단한다.
// 앱 코드는 resources/app.asar에 있으므로 원본 실행기를 복원해도 동일하게 실행된다.
copyFileSync(source, target)
console.log(`실행 가능한 Windows 앱 준비 완료: ${target}`)
