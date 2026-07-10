"use client";

import EditAgent from "./components/EditAgent";
import { Toaster } from "react-hot-toast";

const EditAgentPage = ({ useUser, usedIn = "muapiapp" }) => {
  return (
    <div className="h-dvh w-full flex flex-col bg-[#030303] text-white transition-all duration-300 ease-in-out">
      <Toaster position="top-center" reverseOrder={false} />
      <main className="flex flex-col items-center w-full h-full overflow-y-auto custom-scrollbar">
        <EditAgent useUser={useUser} usedIn={usedIn} />
      </main>
    </div>
  );
};

export default EditAgentPage;
