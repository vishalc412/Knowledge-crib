package org.acme.request;

import java.util.List;
import org.acme.event.EventTeamAuthorizationValidator;
import org.acme.profile.CloudProfile;

public class RequestRoutesLogic {
    private final EventRequestStore store = new EventRequestStore();

    public void submit(CloudProfile profile, EventRequest eventRequest, List<String> gradeBands) {
        EventTeamAuthorizationValidator.validateEventRequestType(profile, eventRequest.getType(),
                gradeBands);
        store.save(eventRequest);
    }

    public void approve(CloudProfile profile, long id) {
        EventRequest er = store.find(id);
        if (er != null) {
            EventTeamAuthorizationValidator.validateEventRequestType(profile, er.getType(),
                    er.getGradeBands());
        }
    }
}
