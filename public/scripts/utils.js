
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