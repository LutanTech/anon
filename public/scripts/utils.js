
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