import { createFFmpeg, fetchFile, type LogCallback } from '@ffmpeg/ffmpeg';
import type { FilmSettings } from '../stores/filmSettingsStore';
import type { MusicSettings } from '../stores/musicSettingsStore';
import type { Scene, TextSettings } from '../stores/scenesStore';
import { getMusicFile, getVideoFile } from './fileGetters';
import { dev } from '$app/env';

export type ProgressCallbackType = (p: { percent: number; remainingRenderingTime: number }) => void;

export class Renderer {
	private startTime = 0;
	private estimatedVideoDuration = 0;
	private progressCallbacks: ProgressCallbackType[] = [];
	private recentLogs: string[] = [];

	private logger: LogCallback = ({ message }) => {
		this.recentLogs.push(message);
		if (this.recentLogs.length > 40) this.recentLogs.shift();

		const timeStringRegex = /(?<=time=).*?(?= )/g;
		const result = timeStringRegex.exec(message);

		if (result === null) return;

		const [hours, minutes, seconds, miliseconds] = result[0].split(/:|\./g).map((r) => parseInt(r));
		const currentMsTime = miliseconds + 100 * (seconds + 60 * (minutes + 60 * hours));

		let percent = (currentMsTime / this.estimatedVideoDuration) * 100;
		if (percent >= 100) {
			percent = 99;
		} else if (percent < 0) {
			percent = 0;
		}

		let remainingRenderingTime = 0;

		if (percent > 0) {
			const timeElapsed = Date.now() - this.startTime;
			const msPerPercent = timeElapsed / percent;
			const fullRenderingTime = msPerPercent * 100;
			remainingRenderingTime = fullRenderingTime - timeElapsed;
		}

		this.progressCallbacks.forEach((c) => c({ percent, remainingRenderingTime }));
	};

	private ffmpeg = createFFmpeg({
		log: dev,
		logger: this.logger
	});

	async load() {
		await this.ffmpeg.load();
		this.ffmpeg.FS('writeFile', 'impact.ttf', await fetchFile('./fonts/impact.ttf'));
	}

	setProgress(callback: ProgressCallbackType) {
		this.progressCallbacks.push(callback);
	}

	unsetProgress(callback: ProgressCallbackType) {
		this.progressCallbacks = this.progressCallbacks.filter((c) => c !== callback);
	}

	async render(scenes: Scene[], filmSettings: FilmSettings, musicSettings: MusicSettings) {
		this.estimatedVideoDuration = scenes.reduce((prev: number, curr: Scene) => {
			return prev + ((curr.endTime - curr.startTime) * 100) / curr.speed;
		}, 0);
		this.startTime = Date.now();
		this.recentLogs = [];
		const writtenFiles: string[] = [];
		const writeFile = (name: string, data: Uint8Array) => {
			this.ffmpeg.FS('writeFile', name, data);
			writtenFiles.push(name);
		};

		// User text is written to a UTF-8 file and read with textfile= + expansion=none.
		// Passing it inline in the filter graph broke on ' : % \\ (issue #2), and
		// ffmpeg.wasm 0.10 writes argv as ASCII, which mangled Cyrillic and accents (issue #5).
		const textFilter = (
			fileName: string,
			{ text, fontSize, borderWidth }: TextSettings,
			y: string
		) => {
			if (text.trim() === '') return '';
			writeFile(fileName, new TextEncoder().encode(text));
			return `drawtext=fontfile=impact.ttf:textfile=${fileName}:expansion=none:fontcolor=white:fontsize=${fontSize}:borderw=${borderWidth}:x=(w-text_w)/2:y=${y},`;
		};

		const { filmWidth, filmHeight, outputFileFormat } = filmSettings;

		const inputFiles = new Array<string>(scenes.length * 2);
		const filters = new Array<string>(scenes.length);
		const concatTracks = new Array<string>(scenes.length);

		const videoWritePromises = scenes.map(
			async ({ video, startTime, endTime, speed, bottomTextSettings, topTextSettings }, index) => {
				const videoFile = await getVideoFile(video);
				const fileExtension = videoFile.name.split('.').pop();
				const newFileName = `${index}.${fileExtension}`;

				writeFile(newFileName, await fetchFile(videoFile));

				inputFiles[index * 2] = '-i';
				inputFiles[index * 2 + 1] = newFileName;
				concatTracks[index] = `[v${index}]`;

				filters[index] = `[${index}:v]
			scale=${filmWidth}:${filmSettings.filmHeight}:force_original_aspect_ratio=decrease,
			pad=${filmWidth}:${filmHeight}:(ow-iw)/2:(oh-ih)/2,
			setsar=1/1,
			${textFilter(
				`bottom${index}.txt`,
				bottomTextSettings,
				`(h-text_h) - ${bottomTextSettings.fontSize / 2}`
			)}
			${textFilter(`top${index}.txt`, topTextSettings, `${topTextSettings.fontSize / 2}`)}
			drawtext=fontfile=impact.ttf:text='first-uninteresting-username.github.io/slander-meme-generator':fontsize=10 * (${
				filmSettings.filmHeight
			} / 480):fontcolor=black:box=1:boxcolor=white@0.5:boxborderw=2:x=w-text_w - 2:y=h-text_h - 2,
			trim=${startTime}:${endTime},
			setpts=${1 / speed}*(PTS-STARTPTS)[v${index}];`;
			}
		);

		await Promise.all(videoWritePromises);

		const musicFile = await getMusicFile(musicSettings.music);
		const fileExtension = musicFile.name.split('.').pop();
		const musicFileName = `m.${fileExtension}`;
		writeFile(musicFileName, await fetchFile(musicFile));
		inputFiles.push('-i', musicFileName);

		const fullOutputFileName = `${Math.random()}.${outputFileFormat}`;
		writtenFiles.push(fullOutputFileName);
		try {
			await this.ffmpeg.run(
				...inputFiles,
				'-filter_complex',
				`${filters.join(' ')}
			${concatTracks.join('')}
			concat=n=${scenes.length}:v=1:a=0 [v]`,
				'-filter_complex',
				`[${scenes.length}:a] atempo=${musicSettings.speed} [a]`,
				'-vsync',
				'vfr',
				'-map',
				'[v]',
				'-map',
				'[a]',
				'-shortest',
				fullOutputFileName
			);

			let data: Uint8Array;
			try {
				data = this.ffmpeg.FS('readFile', fullOutputFileName);
			} catch {
				data = new Uint8Array();
			}
			if (data.length === 0) {
				// ffmpeg failed without producing output: surface its log instead of a generic error
				const log = this.recentLogs.filter((l) => !l.startsWith('frame=')).slice(-12);
				throw new Error(log.join('\n') || 'FFmpeg produced no output');
			}

			return URL.createObjectURL(new Blob([data.buffer], { type: `video/${outputFileFormat}` }));
		} finally {
			// free MEMFS so repeated renders don't exhaust the wasm heap
			for (const name of writtenFiles) {
				try {
					this.ffmpeg.FS('unlink', name);
				} catch {
					/* already gone */
				}
			}
		}
	}
}
