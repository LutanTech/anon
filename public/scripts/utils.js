
function checkLastTab(){
    const lastTab = sessionStorage.getItem('lastTab') || '';
    if(lastTab && lastTab !== 'my-status'){
        switchTab(lastTab)
    }
}


function unMuteVideo(){
    const sv = document.getElementById("status-viewer");
    const video = sv.querySelector('video')
    const vbtn = document.getElementById('volume-btn')
    const i = vbtn.querySelector('i')


    if(video.muted){
       video.muted = false
       video.volume = 1 
       sessionStorage.removeItem('muteVideos')
       vbtn.classList.add('text-white-400')
       vbtn.classList.remove('text-green-500');
       i.classList.remove('fa-volume-up');
       i.classList.add('fa-volume-mute')

    } else{
        video.muted = true
        video.volume = 0
        sessionStorage.setItem('muteVideos', true)
        vbtn.classList.remove('text-green-500');
        vbtn.classList.add('text-white-400')
        i.classList.remove('fa-volume-up')
        i.classList.add('fa-volume-mute')

    }

    
}

        
function timeAgo(timestamp)
{
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return "Just now";

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes} min${minutes > 1 ? "s" : ""} ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours} hour${hours > 1 ? "s" : ""} ago`;

    const days = Math.floor(hours / 24);
    if (days === 1)
        return "Yesterday";

    if (days < 7)
        return `${days} days ago`;

    return new Date(timestamp)
        .toLocaleDateString();
}


document.addEventListener('DOMContentLoaded', ()=>{
    checkLastTab()
    window.unMuteVideo = unMuteVideo
    window.timeAgo = timeAgo

    
})

function showInputPrompt(title,message,value="",placeholder=""){
    return new Promise(resolve=>{
        const old=document.getElementById("custom-input-prompt");
        if(old)old.remove();

        const modal=document.createElement("div");
        modal.id="custom-input-prompt";
        modal.className="fixed inset-0 z-[10000] bg-black/70 backdrop-blur-md flex items-center justify-center p-4";

        modal.innerHTML=`
            <div class="w-full max-w-sm bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden"
                onclick="event.stopPropagation()">

                <div class="flex items-center justify-between px-4 py-3 border-b border-slate-800">
                    <div>
                        <div class="text-sm font-semibold text-white">
                            ${escapeHTML(title)}
                        </div>

                        <div class="text-xs text-slate-500 mt-0.5">
                            ${escapeHTML(message)}
                        </div>
                    </div>

                    <button id="prompt-close"
                        class="w-8 h-8 rounded-lg bg-slate-900 text-slate-400 hover:text-white transition">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>

                <div class="p-4">
                    <input id="prompt-input"
                        type="text"
                        value="${escapeHTML(value)}"
                        placeholder="${escapeHTML(placeholder)}"
                        autocomplete="off"
                        class="w-full px-3 py-3 rounded-xl bg-slate-900 border border-slate-800
                               text-sm text-white placeholder:text-slate-600
                               outline-none focus:border-emerald-500 transition">

                    <div class="flex gap-2 mt-3">
                        <button id="prompt-cancel"
                            class="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700
                                   text-sm text-slate-300 transition">
                            Cancel
                        </button>

                        <button id="prompt-confirm"
                            class="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400
                                   text-sm font-semibold text-white transition">
                            Save
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const input=modal.querySelector("#prompt-input");
        const close=()=>{
            modal.remove();
            resolve(null);
        };

        const confirm=()=>{
            const result=input.value.trim();

            if(!result){
                input.focus();
                input.classList.add("border-red-500");

                setTimeout(()=>{
                    input.classList.remove("border-red-500");
                },500);

                return;
            }

            modal.remove();
            resolve(result);
        };

        modal.querySelector("#prompt-close").onclick=close;
        modal.querySelector("#prompt-cancel").onclick=close;
        modal.querySelector("#prompt-confirm").onclick=confirm;

        modal.onclick=close;

        input.addEventListener("keydown",e=>{
            if(e.key==="Enter"){
                e.preventDefault();
                confirm();
            }

            if(e.key==="Escape"){
                e.preventDefault();
                close();
            }
        });

        requestAnimationFrame(()=>{
            input.focus();
            input.select();
        });
    });
}

async function base64ToFile(base64, name, type) {
    const response = await fetch(base64);
    const blob = await response.blob();

    return new File(
        [blob],
        name,
        {
            type: type || blob.type
        }
    );
}
window.base64ToFile = base64ToFile


function openMediaPlayer(type, src, name){
    const overlay = document.getElementById('media-player-overlay');
    const content = document.getElementById('media-player-content');
    const title = document.getElementById('media-player-title');

    if (!overlay || !content) return;

    title.textContent = name || 'Media';

    const safeSrc = escapeHTML(src);
    const safeName = escapeHTML(name || 'file');

    content.innerHTML = '';

    if (type === 'video')
    {
        content.innerHTML = `
            <div id="anon-video-player"
                 class="w-full max-w-5xl mx-auto">

                <div class="relative overflow-hidden rounded-2xl
                            bg-black border border-slate-800">

                    <video
                        id="anon-media"
                        src="${safeSrc}"
                        autoplay
                        playsinline
                        preload="metadata"
                        class="w-full max-h-[70vh] object-contain">
                    </video>

                    <div class="absolute inset-x-0 bottom-0
                                bg-gradient-to-t from-black/95
                                via-black/70 to-transparent
                                pt-12 px-4 pb-3">

                        <input
                            id="anon-progress"
                            type="range"
                            min="0"
                            max="100"
                            value="0"
                            class="w-full accent-brand-500 cursor-pointer">

                        <div class="flex items-center gap-3 mt-2">

                            <button
                                id="anon-play"
                                class="w-9 h-9 rounded-full
                                       flex items-center justify-center
                                       bg-brand-600 hover:bg-brand-500
                                       text-white">
                                <i class="fas fa-pause"></i>
                            </button>

                            <span
                                id="anon-time"
                                class="text-[11px] text-slate-300
                                       whitespace-nowrap">
                                0:00 / 0:00
                            </span>

                            <button
                                id="anon-mute"
                                class="w-8 h-8 text-slate-300
                                       hover:text-white">
                                <i class="fas fa-volume-up"></i>
                            </button>

                            <input
                                id="anon-volume"
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value="1"
                                class="w-20 accent-brand-500">

                            <select
                                id="anon-speed"
                                class="ml-auto bg-slate-900/90
                                       border border-slate-700
                                       rounded-lg px-2 py-1
                                       text-[10px] text-white">

                                <option value="0.5">0.5x</option>
                                <option value="0.75">0.75x</option>
                                <option value="1" selected>1x</option>
                                <option value="1.25">1.25x</option>
                                <option value="1.5">1.5x</option>
                                <option value="2">2x</option>

                            </select>

                            <button
                                onclick="toggleMediaFullscreen()"
                                class="w-8 h-8 text-slate-300
                                       hover:text-white">

                                <i class="fas fa-expand"></i>

                            </button>

                        </div>
                    </div>
                </div>

                <div class="flex items-center justify-between mt-4">

                    <div class="min-w-0">
                        <div class="text-xs text-slate-200 truncate">
                            ${safeName}
                        </div>

                        <div class="text-[10px] text-slate-500">
                            Video
                        </div>
                    </div>

                    <button
                        onclick="downloadFile('${safeSrc}', '${safeName}')"
                        class="px-4 py-2 rounded-xl
                               bg-brand-600 hover:bg-brand-500
                               text-white text-xs shrink-0">

                        <i class="fas fa-download mr-1"></i>
                        Download

                    </button>

                </div>
            </div>
        `;
    }
    else if (type === 'audio')
    {
        content.innerHTML = `
            <div id="anon-audio-player"
                 class="w-full max-w-xl mx-auto
                        rounded-2xl bg-slate-900
                        border border-slate-700 p-6">

                <audio
                    id="anon-media"
                    src="${safeSrc}"
                    autoplay
                    preload="metadata">
                </audio>

                <div class="flex flex-col items-center">

                    <div class="w-24 h-24 rounded-2xl
                                bg-brand-600/20
                                border border-brand-500/20
                                flex items-center justify-center">

                        <i class="fas fa-music
                                  text-brand-400 text-4xl"></i>

                    </div>

                    <div class="w-full text-center mt-4">

                        <div class="text-sm font-semibold
                                    text-white truncate">

                            ${safeName}

                        </div>

                        <div class="text-[10px] text-slate-500 mt-1">
                            Audio
                        </div>

                    </div>

                    <input
                        id="anon-progress"
                        type="range"
                        min="0"
                        max="100"
                        value="0"
                        class="w-full mt-6 accent-brand-500 cursor-pointer">

                    <div class="w-full flex justify-between
                                text-[10px] text-slate-500 mt-1">

                        <span id="anon-current-time">0:00</span>
                        <span id="anon-duration">0:00</span>

                    </div>

                    <div class="flex items-center
                                justify-center gap-5 mt-5">

                        <button
                            id="anon-play"
                            class="w-12 h-12 rounded-full
                                   bg-brand-600 hover:bg-brand-500
                                   flex items-center justify-center
                                   text-white">

                            <i class="fas fa-pause"></i>

                        </button>

                    </div>

                    <div class="w-full flex items-center gap-3 mt-5">

                        <button
                            id="anon-mute"
                            class="text-slate-400
                                   hover:text-white">

                            <i class="fas fa-volume-up"></i>

                        </button>

                        <input
                            id="anon-volume"
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value="1"
                            class="flex-1 accent-brand-500">

                        <select
                            id="anon-speed"
                            class="bg-slate-800
                                   border border-slate-700
                                   rounded-lg px-2 py-1
                                   text-[10px] text-white">

                            <option value="0.5">0.5x</option>
                            <option value="0.75">0.75x</option>
                            <option value="1" selected>1x</option>
                            <option value="1.25">1.25x</option>
                            <option value="1.5">1.5x</option>
                            <option value="2">2x</option>

                        </select>

                    </div>

                    <button
                        onclick="downloadFile('${safeSrc}', '${safeName}')"
                        class="w-full mt-6 px-4 py-2.5
                               rounded-xl bg-brand-600
                               hover:bg-brand-500
                               text-white text-xs">

                        <i class="fas fa-download mr-1"></i>
                        Download

                    </button>

                </div>
            </div>
        `;
    }

    overlay.classList.remove('hidden');

    const media = document.getElementById('anon-media');
    if (!media) return;

    const progress = document.getElementById('anon-progress');
    const playBtn = document.getElementById('anon-play');
    const volume = document.getElementById('anon-volume');
    const muteBtn = document.getElementById('anon-mute');
    const speed = document.getElementById('anon-speed');

    function formatTime(seconds)
    {
        if (!Number.isFinite(seconds)) return '0:00';

        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60)
            .toString()
            .padStart(2, '0');

        return `${mins}:${secs}`;
    }

    function updatePlayIcon()
    {
        if (!playBtn) return;

        playBtn.innerHTML = media.paused
            ? '<i class="fas fa-play"></i>'
            : '<i class="fas fa-pause"></i>';
    }

    function updateTime()
    {
        if (!media.duration) return;

        const percent =
            (media.currentTime / media.duration) * 100;

        if (progress)
            progress.value = percent;

        if (type === 'video')
        {
            const time = document.getElementById('anon-time');

            if (time)
            {
                time.textContent =
                    `${formatTime(media.currentTime)} / ${formatTime(media.duration)}`;
            }
        }
        else
        {
            const current =
                document.getElementById('anon-current-time');

            const duration =
                document.getElementById('anon-duration');

            if (current)
                current.textContent =
                    formatTime(media.currentTime);

            if (duration)
                duration.textContent =
                    formatTime(media.duration);
        }
    }

    playBtn?.addEventListener('click', () =>
    {
        if (media.paused)
            media.play();
        else
            media.pause();

        updatePlayIcon();
    });

    media.addEventListener('play', updatePlayIcon);
    media.addEventListener('pause', updatePlayIcon);
    media.addEventListener('timeupdate', updateTime);
    media.addEventListener('loadedmetadata', updateTime);

    progress?.addEventListener('input', () =>
    {
        if (!media.duration) return;

        media.currentTime =
            (Number(progress.value) / 100) *
            media.duration;
    });

    volume?.addEventListener('input', () =>
    {
        media.volume = Number(volume.value);

        if (media.volume > 0)
            media.muted = false;

        updateVolumeIcon();
    });

    muteBtn?.addEventListener('click', () =>
    {
        media.muted = !media.muted;
        updateVolumeIcon();
    });

    function updateVolumeIcon()
    {
        if (!muteBtn) return;

        muteBtn.innerHTML =
            media.muted || media.volume === 0
                ? '<i class="fas fa-volume-mute"></i>'
                : media.volume < 0.5
                    ? '<i class="fas fa-volume-down"></i>'
                    : '<i class="fas fa-volume-up"></i>';
    }

    speed?.addEventListener('change', () =>
    {
        media.playbackRate = Number(speed.value);
    });

    media.addEventListener('ended', updatePlayIcon);

    updatePlayIcon();
    updateVolumeIcon();
}

function closeMediaPlayer()
{
    const overlay =
        document.getElementById('media-player-overlay');

    const content =
        document.getElementById('media-player-content');

    const media =
        content.querySelector('video, audio');

    if (media) {
        media.pause();
        media.removeAttribute('src');
        media.load();
    }

    content.innerHTML = '';

    overlay.classList.add('hidden');
}

function toggleMediaFullscreen()
{
    const player =
        document.getElementById('anon-video-player');

    const video =
        document.getElementById('anon-media');

    if (!player || !video) return;

    if (document.fullscreenElement)
    {
        document.exitFullscreen();
        return;
    }

    if (player.requestFullscreen)
    {
        player.requestFullscreen();
    }
    else if (video.webkitEnterFullscreen)
    {
        video.webkitEnterFullscreen();
    }
}

document.addEventListener('seeked', e => {

    if (!e.target.classList.contains('video-thumbnail'))
        return;

    e.target.pause();

}, true);

document.addEventListener('loadedmetadata', e => {

    if (!e.target.classList.contains('video-thumbnail') &&
        !e.target.classList.contains('audio-thumbnail')) {
        return;
    }

    const media = e.target;

    const durationElement =
        document.getElementById(`${media.id}_duration`);

    if (durationElement) {
        durationElement.textContent =
            formatVideoDuration(media.duration);
    }

}, true);

function formatVideoDuration(seconds)
{
    if (!Number.isFinite(seconds))
        return '0:00';

    seconds = Math.floor(seconds);

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    return `${minutes}:${String(secs).padStart(2, '0')}`;
}