.PHONY: all
all: release/SignalsmithStretch.mjs release/SignalsmithStretch.cjs release/SignalsmithStretch.d.mts release/SignalsmithStretch.d.cts release/UPSTREAM.md

release/SignalsmithStretch.mjs: release/SignalsmithStretch.js release/LICENSE.txt release/WINDOWED-SOURCE.md
	@ echo "let module = {}, exports = {};" > release/SignalsmithStretch.mjs
	@ cat release/SignalsmithStretch.js >> release/SignalsmithStretch.mjs
	@ echo "let _export=SignalsmithStretch;export default _export;" >> release/SignalsmithStretch.mjs

release/SignalsmithStretch.cjs: release/SignalsmithStretch.js
	@ cp release/SignalsmithStretch.js release/SignalsmithStretch.cjs

release/SignalsmithStretch.d.mts: SignalsmithStretch.d.ts
	@ cp SignalsmithStretch.d.ts release/SignalsmithStretch.d.mts
	@ echo 'export default SignalsmithStretch;' >> release/SignalsmithStretch.d.mts

release/SignalsmithStretch.d.cts: SignalsmithStretch.d.ts
	@ cp SignalsmithStretch.d.ts release/SignalsmithStretch.d.cts
	@ echo 'export = SignalsmithStretch;' >> release/SignalsmithStretch.d.cts

release/UPSTREAM.md: ../UPSTREAM.md
	@ cp ../UPSTREAM.md release/UPSTREAM.md

release/LICENSE.txt: ../LICENSE.txt
	@ cp ../LICENSE.txt release/LICENSE.txt

release/WINDOWED-SOURCE.md: WINDOWED-SOURCE.md
	@ cp WINDOWED-SOURCE.md release/WINDOWED-SOURCE.md

.PHONY: test
test:
	node --test test/*.test.mjs

release/SignalsmithStretch.js: emscripten/main.js windowed-source.js windowed-transport.js web-wrapper.js
	@ cp emscripten/main.js release/SignalsmithStretch.js
	@ cat windowed-source.js windowed-transport.js >> release/SignalsmithStretch.js
	@ cat web-wrapper.js >> release/SignalsmithStretch.js

emscripten/main.js: emscripten/main.cpp ../signalsmith-stretch.h
	@ emscripten/compile.sh emscripten/main.cpp emscripten/main.js SignalsmithStretch

## Development helpers

jsdoc: release/SignalsmithStretch.js release/SignalsmithStretch.mjs
	npx jsdoc release --verbose

server:
	python3 -m http.server

watch:
	# pip3 install watchdog
	watchmedo shell-command --patterns='*.js;Makefile' --command='make jsdoc;echo "rebuilt"' --drop
